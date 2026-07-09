import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { dotGet, loadTradeConfig } from "../config.js";
import { nowDisplay, runOpencli } from "../data-helpers.js";
import { extractJsonFromText, runAgent } from "../llm-utils.js";
import { TRADE_STATE_DIR } from "../../paths.js";
import { classifyCelebritySearchSnapshot } from "../celebrity-search.js";

const SEEN_TWEETS_DB = `${TRADE_STATE_DIR}/celebrity_seen.jsonl`;
const TWITTER_SEARCH_SESSION = "trade-twitter-search";
const SEEN_TWEET_TTL_SECONDS = 86400 * 3;
const NON_ALPHA_RETRY_SECONDS = 5 * 60;

const ENTITY_BLACKLIST = new Set([
  "USD",
  "USDT",
  "USDC",
  "AI",
  "CEO",
  "CFO",
  "IPO",
  "ETF",
  "USA",
  "NEW",
  "NFT",
  "DEFI",
  "WEB3",
  "FED",
]);

const WARNING_ALPHA_TYPES = new Set(["endorsement", "partnership", "ipo", "policy"]);
/** LLM confidence at/above this can surface as warning when type/entities also qualify. */
const DEFAULT_MIN_CONFIDENCE_WARNING = 0.72;
/** Below this, treat as non-actionable even if model set is_alpha=true. */
const DEFAULT_MIN_CONFIDENCE_ALERT = 0.55;
const PARSE_FAIL_RETRY_SECONDS = 15 * 60;

const ENTITY_PROMPT_TPL = `你是全自动加密 alpha 判定引擎（无人工复核）。对下面推文自主做最终判定:
是否会出现「资金/注意力向可交易标的集中」的催化剂。只输出 JSON,系统会原样执行你的判断。

发推人: @{author}
推文: "{text}"

【判定原则】
- 你全权决定 is_alpha / alpha_type / confidence / entities;不要请示人类,不要写解释性散文。
- confidence 必须是 0~1 的小数,反映你对「可交易 alpha」的把握;不确定就压低 confidence 或判 false。
- entities 只能是推文里明确出现的可交易标的: $TICKER、token/项目名、合约相关名称;禁止抽人名账号、国家、口号、通用词(AI/CEO/FED 等)。
- is_alpha=true 时至少给 1 个 entity;给不出具体标的就 is_alpha=false。
- 名人随口点名若没有可交易标的或行动,不要抬成 endorsement。

【is_alpha=true】(满足任一,且有可交易 entity)
1. IPO / 上市 / launchpad / 新 token 发行
2. 命名 / 品牌 / 吉祥物 → 明确 token 或 meme 标的
3. 持仓权益 / utility / perk 指向具体 token
4. 合作 / 收购 / 投资 / 购买 / endorse,且点名标的
5. 政策/监管使具体 token 或明确板块直接受益
6. 发推人 + 具体动作 + 具体标的

【is_alpha=false】
段子/反讽/抒情/日常;泛政治或宏观无标的;旧闻复读无新信息;纯转发无增量;
只有情绪没有标的;无法指出可买/可炒的对象。

【alpha_type】ipo|naming|utility|partnership|policy|endorsement|none
【reason】≤20 字中文依据

只返回一行 JSON,无 markdown:
{"is_alpha":true|false,"alpha_type":"endorsement","confidence":0.0,"reason":"...","entities":["TICKER"]}

is_alpha=false 时: confidence 可保留,entities 必须 []。`;

const TWEET_UI_FRAGMENT_RE =
  /^(?:@\w+|·|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}|\d{1,2}:\d{2}|\d+(?:\.\d+)?[KMB]?|\d+(?:\.\d+)?[KMB]?\s*(?:views?|likes?|reposts?)?)$/i;

interface ChainFmRef {
  chain: string;
  address: string;
  url: string;
}

interface SeenTweetRecord {
  id?: string;
  ts?: number;
  ttl_seconds?: number;
}

function chainFmUrl(chain: string, address: string): string {
  return `https://chain.fm/token/${chain}/${address}`;
}

export function isCelebritySeenRecordActive(record: SeenTweetRecord, nowSeconds = Date.now() / 1000): boolean {
  if (!record.id || !record.ts) return false;
  const ttl = Number(record.ttl_seconds ?? SEEN_TWEET_TTL_SECONDS);
  if (!Number.isFinite(ttl) || ttl <= 0) return false;
  return nowSeconds - record.ts < ttl;
}

export function extractChainFmRefs(text: string): ChainFmRef[] {
  const chainMap: Record<string, string> = {
    solana: "solana",
    sol: "solana",
    bsc: "bsc",
    ethereum: "ethereum",
    eth: "ethereum",
    base: "base",
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
      url: chainFmUrl(chainRaw, address),
    });
  }
  return refs;
}

async function loadSeenIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const now = Date.now() / 1000;
  try {
    const raw = await readFile(SEEN_TWEETS_DB, "utf8");
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      try {
        const rec = JSON.parse(line) as SeenTweetRecord;
        if (isCelebritySeenRecordActive(rec, now) && rec.id) ids.add(rec.id);
      } catch {}
    }
  } catch {
    // file may not exist
  }
  return ids;
}

async function persistSeen(tid: string, ttlSeconds = SEEN_TWEET_TTL_SECONDS): Promise<void> {
  await mkdir(dirname(SEEN_TWEETS_DB), { recursive: true });
  await appendFile(
    SEEN_TWEETS_DB,
    `${JSON.stringify({ id: tid, ts: Date.now() / 1000, ttl_seconds: ttlSeconds })}\n`,
    "utf8",
  );
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
  return {
    title: document.title,
    url: location.href,
    text: document.body.innerText.slice(0, 1600),
    articles: document.querySelectorAll('article').length,
    tweets: out
  };
})()`;
    for (let attempt = 0; attempt < 3; attempt++) {
      await runOpencli(["browser", TWITTER_SEARCH_SESSION, "close"], 10_000);
      const opened = await runOpencli(
        ["browser", TWITTER_SEARCH_SESSION, "--window", "background", "open", url],
        30_000,
      );
      if (!opened.ok) continue;
      await runOpencli(["browser", TWITTER_SEARCH_SESSION, "--window", "background", "wait", "time", "5"], 10_000);
      const evalResult = await runOpencli(
        ["browser", TWITTER_SEARCH_SESSION, "--window", "background", "eval", js],
        30_000,
      );
      if (!evalResult.ok) continue;
      const page = evalResult.data.find(
        (row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row),
      );
      const status = classifyCelebritySearchSnapshot(username, page ?? { url }).status;
      if (status === "no-results" || status === "auth-required" || status === "challenge") return [];
      const tweets = Array.isArray(page?.tweets) ? page.tweets : [];
      const rows = tweets.filter(
        (row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row),
      );
      if (rows.length) return rows;
    }
    return [];
  } catch {
    return [];
  }
}

export interface CelebrityAlphaMeta {
  is_alpha: boolean;
  alpha_type: string;
  confidence: number;
  reason: string;
  /** true when model JSON was unusable; caller should short-retry without treating as non-alpha. */
  parse_failed?: boolean;
  /** entities dropped by grounding/blacklist (for audit). */
  grounded_out?: string[];
}

export interface CelebrityAlphaDecision {
  entities: string[];
  meta: CelebrityAlphaMeta;
}

/** Keep entities that appear in the tweet (case-insensitive) or as $TICKER. */
export function groundEntitiesInText(text: string, entities: string[]): { kept: string[]; dropped: string[] } {
  const hay = text.toLowerCase();
  const kept: string[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const raw of entities) {
    if (typeof raw !== "string") continue;
    const s = raw.trim().replace(/^\$/, "");
    if (s.length < 2 || s.length > 30) {
      dropped.push(String(raw));
      continue;
    }
    const upper = s.toUpperCase();
    if (ENTITY_BLACKLIST.has(upper)) {
      dropped.push(s);
      continue;
    }
    const needle = s.toLowerCase();
    const inText = hay.includes(needle) || hay.includes(`$${needle}`);
    if (!inText) {
      dropped.push(s);
      continue;
    }
    if (seen.has(upper)) continue;
    seen.add(upper);
    kept.push(s);
  }
  return { kept, dropped };
}

export function clampConfidence(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Turn raw LLM JSON into an executable autonomous decision.
 * Code only grounds entities / clamps confidence — it does not ask a human.
 */
export function resolveCelebrityAlphaDecision(
  parsed: Record<string, unknown> | null,
  tweetText: string,
  options: { minConfidenceAlert?: number } = {},
): CelebrityAlphaDecision {
  const minAlert = options.minConfidenceAlert ?? DEFAULT_MIN_CONFIDENCE_ALERT;
  if (!parsed || typeof parsed !== "object" || typeof parsed.is_alpha !== "boolean") {
    return {
      entities: [],
      meta: {
        is_alpha: false,
        alpha_type: "none",
        confidence: 0,
        reason: "parse_failed",
        parse_failed: true,
      },
    };
  }

  const confidence = clampConfidence(parsed.confidence, parsed.is_alpha ? 0.6 : 0.2);
  const alphaType = String(parsed.alpha_type ?? "none");
  const reason = String(parsed.reason ?? "").slice(0, 80);
  const rawEnts = Array.isArray(parsed.entities) ? parsed.entities.map(String) : [];
  const { kept, dropped } = groundEntitiesInText(tweetText, rawEnts);

  let isAlpha = Boolean(parsed.is_alpha);
  // Autonomous consistency: no grounded tradable entity ⇒ not actionable alpha.
  if (isAlpha && kept.length === 0) {
    isAlpha = false;
  }
  if (isAlpha && confidence < minAlert) {
    isAlpha = false;
  }

  return {
    entities: isAlpha ? kept : [],
    meta: {
      is_alpha: isAlpha,
      alpha_type: isAlpha ? alphaType : alphaType === "none" ? "none" : alphaType,
      confidence,
      reason: isAlpha ? reason : kept.length === 0 && parsed.is_alpha ? reason || "no_grounded_entity" : reason,
      grounded_out: dropped.length ? dropped : undefined,
    },
  };
}

async function extractEntities(
  text: string,
  author: string,
  minConfidenceAlert: number,
): Promise<CelebrityAlphaDecision> {
  const prompt = ENTITY_PROMPT_TPL.replace("{text}", text.slice(0, 500)).replace("{author}", author);
  const result = await runAgent(prompt, { timeoutMs: 45_000, task: "celebrity_extract" });
  const parsed = extractJsonFromText(result) as Record<string, unknown> | null;
  return resolveCelebrityAlphaDecision(parsed, text, { minConfidenceAlert });
}

export function isLikelyTweetUiFragment(text: string, author: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length || lines.length > 12) return false;
  const authorRe = new RegExp(`^@?${author.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const nonUi = lines.filter((line) => {
    if (authorRe.test(line)) return false;
    if (line.toLowerCase() === "donald j. trump" && author.toLowerCase() === "realdonaldtrump") return false;
    return !TWEET_UI_FRAGMENT_RE.test(line);
  });
  return nonUi.length === 0;
}

/**
 * Autonomous severity: LLM confidence + type drive push level; no human gate.
 * warning → eligible for Telegram; info → JSONL audit only.
 */
export function celebrityAlertSeverity(
  alphaType: string,
  entityCount: number,
  confidence = 1,
  minConfidenceWarning = DEFAULT_MIN_CONFIDENCE_WARNING,
): Alert["severity"] {
  if (confidence < minConfidenceWarning) return "info";
  if (WARNING_ALPHA_TYPES.has(alphaType) || entityCount >= 3 || confidence >= 0.9) return "warning";
  return "info";
}

export function createRuleTCelebrity(): AlertRule {
  let seen = new Set<string>();
  let accounts: string[] = [];
  let fetchLimit = 10;

  return {
    name: "celebrity_tweet",
    ruleKey: "celebrity",
    defaultCooldown: 600,
    async check(state: AlertState): Promise<Alert[]> {
      const config = await loadTradeConfig();
      const cfg = (dotGet(config, "alerts.celebrity_tweet", {}) ?? {}) as Record<string, unknown>;
      accounts = Array.isArray(cfg.accounts) ? cfg.accounts.map(String) : [];
      fetchLimit = Number(cfg.fetch_limit ?? 10);
      const minConfidenceAlert = clampConfidence(
        cfg.min_confidence_alert ?? DEFAULT_MIN_CONFIDENCE_ALERT,
        DEFAULT_MIN_CONFIDENCE_ALERT,
      );
      const minConfidenceWarning = clampConfidence(
        cfg.min_confidence_warning ?? DEFAULT_MIN_CONFIDENCE_WARNING,
        DEFAULT_MIN_CONFIDENCE_WARNING,
      );
      seen = await loadSeenIds();

      const alerts: Alert[] = [];
      for (const user of accounts) {
        for (const tw of await fetchTweets(user, fetchLimit)) {
          const tid = String(tw.id ?? "");
          if (!tid || seen.has(tid)) continue;
          const markSeen = async (ttlSeconds = SEEN_TWEET_TTL_SECONDS) => {
            seen.add(tid);
            await persistSeen(tid, ttlSeconds);
          };
          const text = String(tw.text ?? "").trim();
          if (text.length < 10) {
            await markSeen();
            continue;
          }
          if (isLikelyTweetUiFragment(text, user)) {
            await markSeen();
            continue;
          }

          // LLM autonomous decision; no human approval gate.
          const { entities, meta } = await extractEntities(text, user, minConfidenceAlert);
          if (meta.parse_failed) {
            await markSeen(PARSE_FAIL_RETRY_SECONDS);
            continue;
          }
          if (!meta.is_alpha) {
            await markSeen(NON_ALPHA_RETRY_SECONDS);
            continue;
          }
          if (!entities.length) {
            await markSeen(NON_ALPHA_RETRY_SECONDS);
            continue;
          }
          if (!state.canAlert(`t_${tid}`, 600)) {
            await markSeen();
            continue;
          }

          const alphaType = String(meta.alpha_type ?? "none");
          const reason = String(meta.reason ?? "");
          const confidence = meta.confidence;
          const chainRefs = extractChainFmRefs(text);
          const entityLabel = entities.slice(0, 3).join(", ");
          const title = `@${user} [${alphaType} ${confidence.toFixed(2)}] → ${entityLabel}`;
          const lines = [
            `⚡ alpha=${alphaType} conf=${confidence.toFixed(2)} — ${reason}`,
            `💬 ${text.slice(0, 200)}`,
            `🔗 ${String(tw.url ?? "")}`,
            `🎯 entities: ${entities.join(", ")}`,
          ];
          if (meta.grounded_out?.length) {
            lines.push(`🧹 dropped(ungrounded): ${meta.grounded_out.join(", ")}`);
          }
          if (chainRefs.length) {
            lines.push("", "📋 推文内 chain.fm 链接:");
            for (const ref of chainRefs) {
              lines.push(`  ${ref.chain} ${ref.address}`);
              lines.push(`  ${ref.url}`);
            }
          }

          const primaryRef = chainRefs[0];
          alerts.push(
            createAlert({
              ruleId: "celebrity",
              severity: celebrityAlertSeverity(alphaType, entities.length, confidence, minConfidenceWarning),
              title,
              detail: lines.join("\n"),
              timestamp: nowDisplay(),
              asset: entities[0] ?? "",
              tokenContract: primaryRef?.address ?? "",
              tokenChain: primaryRef?.chain ?? "",
              tags: ["celebrity", "llm_autonomous", `conf_${confidence.toFixed(2)}`],
            }),
          );
          await markSeen();
        }
      }
      return alerts;
    },
  };
}
