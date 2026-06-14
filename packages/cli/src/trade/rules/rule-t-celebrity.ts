import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { dotGet, loadTradeConfig } from "../config.js";
import { nowDisplay, runOpencli } from "../data-helpers.js";
import { extractJsonFromText, runAgent } from "../llm-utils.js";
import { TRADE_STATE_DIR } from "../../paths.js";

const SEEN_TWEETS_DB = `${TRADE_STATE_DIR}/celebrity_seen.jsonl`;
const TWITTER_SEARCH_SESSION = "trade-twitter-search";

const ENTITY_BLACKLIST = new Set([
  "USD", "USDT", "USDC", "AI", "CEO", "CFO", "IPO", "ETF",
  "USA", "NEW", "NFT", "DEFI", "WEB3", "FED"
]);

const WARNING_ALPHA_TYPES = new Set(["endorsement", "partnership", "ipo", "policy"]);

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

interface ChainFmRef {
  chain: string;
  address: string;
  url: string;
}

function chainFmUrl(chain: string, address: string): string {
  return `https://chain.fm/token/${chain}/${address}`;
}

export function extractChainFmRefs(text: string): ChainFmRef[] {
  const chainMap: Record<string, string> = {
    solana: "solana", sol: "solana", bsc: "bsc", ethereum: "ethereum", eth: "ethereum", base: "base"
  };
  const seen = new Set<string>();
  const refs: ChainFmRef[] = [];
  for (const match of text.matchAll(/chain\.fm\/token\/(\w+)\/([0-9a-zA-Z]+)/gi)) {
    const chainRaw = match[1]!.toLowerCase();
    const address = match[2]!;
    const key = `${chainRaw}:${address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      chain: chainMap[chainRaw] ?? chainRaw,
      address,
      url: chainFmUrl(chainRaw, address)
    });
  }
  return refs;
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
    const url = `https://x.com/search?q=${encodeURIComponent(`from:${username}`)}&f=live`;
    const js = `(function() {
  const out = [];
  const seen = new Set();
  for (const article of document.querySelectorAll('article')) {
    const textEl = article.querySelector('[data-testid="tweetText"]') || article;
    const text = textEl ? textEl.innerText.trim() : '';
    const link = article.querySelector('a[href*="/status/"]');
    const href = link ? (link.getAttribute('href') || '') : '';
    const idMatch = href.match(/status\\/(\\d+)/);
    const id = idMatch ? idMatch[1] : '';
    if (!text && !id) continue;
    const key = id || text.slice(0, 100);
    if (seen.has(key)) continue;
    seen.add(key);
    const timeEl = article.querySelector('time');
    out.push({
      id,
      text,
      author: ${JSON.stringify(username)},
      created_at: timeEl ? (timeEl.getAttribute('datetime') || timeEl.innerText || '') : '',
      likes: 0,
      views: 0,
      url: id ? 'https://x.com/i/status/' + id : (href ? new URL(href, location.origin).href : '')
    });
    if (out.length >= ${Math.max(1, Math.min(fetchLimit, 50))}) break;
  }
  return out;
})()`;
    for (let attempt = 0; attempt < 3; attempt++) {
      await runOpencli(["browser", TWITTER_SEARCH_SESSION, "close"], 10_000);
      await runOpencli(["browser", TWITTER_SEARCH_SESSION, "--window", "foreground", "open", url], 30_000);
      await runOpencli(["browser", TWITTER_SEARCH_SESSION, "--window", "foreground", "wait", "time", "5"], 10_000);
      await runOpencli(["browser", TWITTER_SEARCH_SESSION, "--window", "foreground", "wait", "selector", "article", "--timeout", "30000"], 35_000);
      const evalResult = await runOpencli(["browser", TWITTER_SEARCH_SESSION, "--window", "foreground", "eval", js], 30_000);
      if (!evalResult.ok) continue;
      const rows = evalResult.data
        .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row));
      if (rows.length) return rows;
    }
    return [];
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

export function celebrityAlertSeverity(alphaType: string, entityCount: number): Alert["severity"] {
  if (WARNING_ALPHA_TYPES.has(alphaType) || entityCount >= 3) return "warning";
  return "info";
}

export function createRuleTCelebrity(): AlertRule {
  let seen = new Set<string>();
  let accounts: string[] = [];
  let fetchLimit = 10;

  return {
    name: "celebrity_tweet",
    ruleKey: "t",
    defaultCooldown: 600,
    async check(state: AlertState): Promise<Alert[]> {
      const config = await loadTradeConfig();
      const cfg = (dotGet(config, "alerts.celebrity_tweet", {}) ?? {}) as Record<string, unknown>;
      accounts = Array.isArray(cfg.accounts) ? cfg.accounts.map(String) : [];
      fetchLimit = Number(cfg.fetch_limit ?? 10);
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
          if (!state.canAlert(`t_${tid}`, 600)) continue;

          const alphaType = String(meta.alpha_type ?? "none");
          const reason = String(meta.reason ?? "");
          const chainRefs = extractChainFmRefs(text);
          const entityLabel = entities.slice(0, 3).join(", ");
          const title = `@${user} [${alphaType}] → ${entityLabel}`;
          const lines = [
            `⚡ alpha=${alphaType} — ${reason}`,
            `💬 ${text.slice(0, 200)}`,
            `🔗 ${String(tw.url ?? "")}`,
            `🎯 抽取 entities: ${entities.join(", ")}`
          ];
          if (chainRefs.length) {
            lines.push("", "📋 推文内 chain.fm 链接:");
            for (const ref of chainRefs) {
              lines.push(`  ${ref.chain} ${ref.address}`);
              lines.push(`  ${ref.url}`);
            }
          }

          const primaryRef = chainRefs[0];
          alerts.push(createAlert({
            rule: "t",
            severity: celebrityAlertSeverity(alphaType, entities.length),
            title,
            detail: lines.join("\n"),
            timestamp: nowDisplay(),
            asset: entities[0] ?? "",
            tokenContract: primaryRef?.address ?? "",
            tokenChain: primaryRef?.chain ?? ""
          }));
        }
      }
      return alerts;
    }
  };
}