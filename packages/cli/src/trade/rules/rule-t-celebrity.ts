import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { dotGet, loadTradeConfig } from "../config.js";
import { gmgnTokenInfo, nowDisplay, runOnchainos, runOpencli } from "../data-helpers.js";
import { extractJsonFromText, runAgent } from "../llm-utils.js";
import { TRADE_STATE_DIR } from "../../paths.js";

const SEEN_TWEETS_DB = `${TRADE_STATE_DIR}/celebrity_seen.jsonl`;
const CHAIN_MAP: Record<string, string> = { "1": "ethereum", "501": "solana", "56": "bsc" };
const GMGN_CHAIN_MAP: Record<string, string> = { solana: "sol", ethereum: "eth", bsc: "bsc", base: "base" };

const ENTITY_BLACKLIST = new Set([
  "USD", "USDT", "USDC", "AI", "CEO", "CFO", "IPO", "ETF",
  "USA", "NEW", "NFT", "DEFI", "WEB3", "FED"
]);

const NATIVE_SYMBOL_BLACKLIST = new Set([
  "SOL", "BTC", "ETH", "BNB", "MATIC", "AVAX", "ADA", "DOT", "TRX",
  "WBTC", "WETH", "STETH", "WBNB", "WSOL",
  "USDT", "USDC", "DAI", "BUSD", "TUSD", "FDUSD"
]);

const ENTITY_PROMPT_TPL = `你是加密 meme 币 alpha 信号过滤器。判定这条推文是否描述了
"会积聚资金/注意力到特定 token 或标的"的催化剂事件,仅当是真实 alpha
事件时再提取相关 entity。

发推人: @{author} (注: 为 Trump/Musk/CZ 级影响力名人,他们的 endorse/购买
/announcement 单独构成 alpha — 即使行文像随手发,也应识别为 endorsement)

推文: "{text}"

【is_alpha = true 的条件】(满足任一)
  1. IPO / 上市 / launchpad 启动 / 新 token 发行
  2. 命名 / 品牌 / 吉祥物事件
  3. 给持仓人具体权益 / utility / perk
  4. 重大合作 / 收购 / 投资 / 名人 endorse + 行动
  5. 政府 / 监管 / 政策 → 特定 token 直接受益
  6. 名人 + 具体动作 + 具体标的的组合

【is_alpha = false】(过滤掉)
  - 段子 / 玩笑 / 吐槽 / 抒情 / 个人日常 / 泛泛政治讨论

【entities 提取】仅当 is_alpha=true 时提取,最多 5 个

只返回 JSON,无 markdown:
{"is_alpha":true|false,"alpha_type":"ipo|naming|utility|partnership|policy|endorsement|none","reason":"<15 字判定依据>","entities":["entity1"]}

is_alpha=false 时 entities 必须返回 [].`;

interface TokenCandidate {
  symbol: string;
  address: string;
  chain: string;
  mcap: number;
  matched_entity: string;
  kol_smart?: number;
  kol_renowned?: number;
  kol_total?: number;
  score?: number;
}

async function loadSeenIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const cutoff = Date.now() / 1000 - 86400 * 3;
  try {
    const raw = await readFile(SEEN_TWEETS_DB, "utf8");
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      try {
        const rec = JSON.parse(line) as { id?: string; ts?: number };
        if ((rec.ts ?? 0) >= cutoff && rec.id) ids.add(rec.id);
      } catch {
        continue;
      }
    }
  } catch {
    // file may not exist
  }
  return ids;
}

async function persistSeen(tid: string): Promise<void> {
  await mkdir(dirname(SEEN_TWEETS_DB), { recursive: true });
  await appendFile(SEEN_TWEETS_DB, `${JSON.stringify({ id: tid, ts: Date.now() / 1000 })}\n`, "utf8");
}

async function fetchTweets(username: string, fetchLimit: number): Promise<Array<Record<string, unknown>>> {
  try {
    const rows = await runOpencli([
      "twitter", "search", `from:${username}`,
      "--filter", "live",
      "--limit", String(fetchLimit),
      "--site-session", "persistent",
      "--keep-tab", "true",
      "--format", "json"
    ], 60_000);
    if (rows.length && Array.isArray(rows[0])) return rows[0] as Array<Record<string, unknown>>;
    return rows as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

async function extractEntities(text: string, author: string): Promise<{ entities: string[]; meta: Record<string, unknown> }> {
  const prompt = ENTITY_PROMPT_TPL.replace("{text}", text.slice(0, 500)).replace("{author}", author);
  const result = await runAgent(prompt, { timeoutMs: 30_000, task: "summarize" });
  const parsed = extractJsonFromText(result) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== "object") return { entities: [], meta: {} };
  const meta = {
    is_alpha: Boolean(parsed.is_alpha),
    alpha_type: String(parsed.alpha_type ?? "none"),
    reason: String(parsed.reason ?? "").slice(0, 80)
  };
  if (!meta.is_alpha) return { entities: [], meta };
  const ents = Array.isArray(parsed.entities) ? parsed.entities : [];
  const clean: string[] = [];
  for (const e of ents) {
    if (typeof e !== "string") continue;
    const s = e.trim();
    if (s.length < 2 || s.length > 30) continue;
    if (ENTITY_BLACKLIST.has(s.toUpperCase())) continue;
    clean.push(s);
  }
  return { entities: clean, meta };
}

async function findTopTokens(
  entities: string[],
  topN: number,
  enrichPool: number,
  kolDivisor: number
): Promise<TokenCandidate[]> {
  const seenAddrs = new Map<string, TokenCandidate>();
  for (const ent of entities) {
    if (NATIVE_SYMBOL_BLACKLIST.has(ent.toUpperCase())) continue;
    const data = await runOnchainos(["token", "search", "--query", ent]);
    const toks = Array.isArray(data)
      ? data
      : (data && typeof data === "object" ? (data as Record<string, unknown>).tokens : []);
    const tokenList = Array.isArray(toks) ? toks : [];
    for (const tok of tokenList.slice(0, 10)) {
      if (!tok || typeof tok !== "object") continue;
      const t = tok as Record<string, unknown>;
      const addr = String(t.tokenContractAddress ?? t.tokenAddress ?? "");
      if (!addr || seenAddrs.has(addr)) continue;
      const sym = String(t.tokenSymbol ?? "").toUpperCase();
      const name = String(t.tokenName ?? "").toUpperCase();
      const entU = ent.toUpperCase();
      if (!sym.includes(entU) && !name.includes(entU)) continue;
      if (NATIVE_SYMBOL_BLACKLIST.has(sym)) continue;
      const mcap = Number.parseFloat(String(t.marketCap ?? t.usd_market_cap ?? 0));
      if (!Number.isFinite(mcap) || mcap <= 0) continue;
      const ch = CHAIN_MAP[String(t.chainIndex ?? "")] ?? "";
      if (!ch) continue;
      seenAddrs.set(addr, {
        symbol: String(t.tokenSymbol ?? "?"),
        address: addr,
        chain: ch,
        mcap,
        matched_entity: ent
      });
    }
  }
  if (!seenAddrs.size) return [];

  let candidates = [...seenAddrs.values()].sort((a, b) => b.mcap - a.mcap);
  candidates = candidates.slice(0, Math.max(topN + 2, enrichPool));

  for (const c of candidates) {
    const gchain = GMGN_CHAIN_MAP[c.chain] ?? c.chain.slice(0, 3);
    const info = await gmgnTokenInfo(gchain, c.address);
    const wt = (info.wallet_tags_stat ?? {}) as Record<string, unknown>;
    c.kol_smart = Number(wt.smart_wallets ?? 0);
    c.kol_renowned = Number(wt.renowned_wallets ?? 0);
    c.kol_total = (c.kol_smart ?? 0) + (c.kol_renowned ?? 0);
    c.score = c.mcap * (1 + (c.kol_total ?? 0) / kolDivisor);
  }

  return candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, topN);
}

export function createRuleTCelebrity(): AlertRule {
  let seen = new Set<string>();
  let accounts: string[] = [];
  let topN = 3;
  let fetchLimit = 10;
  let warningMcap = 1_000_000;
  let warningKol = 30;
  let enrichPool = 5;
  let kolDivisor = 100;

  return {
    name: "celebrity_tweet",
    ruleKey: "t",
    defaultCooldown: 600,
    async check(state: AlertState): Promise<Alert[]> {
      const config = await loadTradeConfig();
      const cfg = (dotGet(config, "alerts.celebrity_tweet", {}) ?? {}) as Record<string, unknown>;
      accounts = Array.isArray(cfg.accounts) ? cfg.accounts.map(String) : [];
      topN = Number(cfg.top_n ?? 3);
      fetchLimit = Number(cfg.fetch_limit ?? 10);
      warningMcap = Number(cfg.warning_mcap ?? 1_000_000);
      warningKol = Number(cfg.warning_kol ?? 30);
      enrichPool = Number(cfg.enrich_pool ?? 5);
      kolDivisor = Number(cfg.kol_divisor ?? 100);
      seen = await loadSeenIds();

      const alerts: Alert[] = [];
      for (const user of accounts) {
        for (const tw of await fetchTweets(user, fetchLimit)) {
          const tid = String(tw.id ?? "");
          if (!tid || seen.has(tid)) continue;
          seen.add(tid);
          await persistSeen(tid);
          const text = String(tw.text ?? "").trim();
          if (text.length < 10) continue;

          const { entities, meta } = await extractEntities(text, user);
          if (!meta.is_alpha || !entities.length) continue;

          const topTokens = await findTopTokens(entities, topN, enrichPool, kolDivisor);
          if (!topTokens.length) continue;
          if (!state.canAlert(`t_${tid}`, 600)) continue;

          const primary = topTokens[0]!;
          const alphaType = String(meta.alpha_type ?? "none");
          const reason = String(meta.reason ?? "");
          const title = `@${user} [${alphaType}] → $${primary.symbol} (MC $${primary.mcap.toLocaleString()} · KOL ${primary.kol_total ?? 0})`;
          const lines = [
            `⚡ alpha=${alphaType} — ${reason}`,
            `💬 ${text.slice(0, 200)}`,
            `🔗 ${String(tw.url ?? "")}`,
            `🎯 抽取 entities: ${entities.join(", ")}`,
            "",
            `📊 Top ${topTokens.length} by mcap×KOL score:`
          ];
          for (let i = 0; i < topTokens.length; i++) {
            const t = topTokens[i]!;
            lines.push(
              `  ${i + 1}. $${t.symbol} (${t.chain}) MC $${t.mcap.toLocaleString()} · KOL ${t.kol_total ?? 0} ` +
              `(smart=${t.kol_smart ?? 0}, renowned=${t.kol_renowned ?? 0}) — matched '${t.matched_entity}'`
            );
            lines.push(`     https://gmgn.ai/${t.chain}/token/${t.address}`);
          }

          const kolSignal = (primary.kol_total ?? 0) >= warningKol;
          const mcapSignal = primary.mcap >= warningMcap;
          const severity: Alert["severity"] = kolSignal || mcapSignal ? "warning" : "info";

          alerts.push(createAlert({
            rule: "t",
            severity,
            title,
            detail: lines.join("\n"),
            timestamp: nowDisplay(),
            asset: primary.symbol,
            tokenContract: primary.address,
            tokenChain: primary.chain,
            tokenMcap: primary.mcap
          }));
        }
      }
      return alerts;
    }
  };
}
