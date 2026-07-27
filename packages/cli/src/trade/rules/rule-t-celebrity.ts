import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { dotGet, loadTradeConfig } from "../config.js";
import type { CliRunResult } from "../cli-result.js";
import { nowDisplay, runOpencli } from "../data-helpers.js";
import { extractJsonFromText, runAgent } from "../llm-utils.js";
import { TRADE_STATE_DIR } from "../../paths.js";
import { classifyCelebritySearchSnapshot } from "../celebrity-search.js";

const SEEN_TWEETS_DB = `${TRADE_STATE_DIR}/celebrity_seen.jsonl`;
const TWITTER_SEARCH_SESSION = "trade-twitter-search";
export const SEEN_TWEET_TTL_SECONDS = 86400 * 3;
export const NON_ALPHA_SEEN_SECONDS = 6 * 3600;
const PARSE_FAIL_WINDOW_SECONDS = 6 * 3600;

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
export const PARSE_FAIL_RETRY_SECONDS = 15 * 60;

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

export interface SeenTweetRecord {
  id?: string;
  ts?: number;
  ttl_seconds?: number;
  outcome?: string;
  attempts?: number;
}

function chainFmUrl(chain: string, address: string): string {
  return `https://chain.fm/token/${chain}/${address}`;
}

export function isCelebritySeenRecordActive(record: SeenTweetRecord, nowSeconds = Date.now() / 1000): boolean {
  if (!record.id || typeof record.ts !== "number" || !Number.isFinite(record.ts)) return false;
  const ttl = Number(record.ttl_seconds ?? SEEN_TWEET_TTL_SECONDS);
  if (!Number.isFinite(ttl) || ttl <= 0) return false;
  return nowSeconds - record.ts < ttl;
}

export function parseFailMarkTtl(attempts: number): number {
  const normalized = Math.max(1, Math.floor(Number(attempts) || 1));
  return Math.min(60 * 60, PARSE_FAIL_RETRY_SECONDS * 2 ** (normalized - 1));
}

function isLegacyParseFailure(record: SeenTweetRecord): boolean {
  return record.outcome == null && record.attempts == null && Number(record.ttl_seconds) === PARSE_FAIL_RETRY_SECONDS;
}

function recordTimestamp(record: SeenTweetRecord): number | null {
  const ts = Number(record.ts);
  return Number.isFinite(ts) ? ts : null;
}

export function parseSeenStateLines(
  lines: string[],
  nowSeconds: number,
): { active: Set<string>; parseFails: Map<string, number> } {
  const active = new Set<string>();
  const parseFails = new Map<string, number>();
  const latest = new Map<string, SeenTweetRecord>();
  const history = new Map<string, SeenTweetRecord[]>();
  for (const line of lines) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as SeenTweetRecord;
      if (!rec || typeof rec !== "object" || !rec.id || recordTimestamp(rec) == null) continue;
      const records = history.get(rec.id) ?? [];
      records.push(rec);
      history.set(rec.id, records);
      const current = latest.get(rec.id);
      if (!current || (recordTimestamp(rec) ?? 0) >= (recordTimestamp(current) ?? 0)) latest.set(rec.id, rec);
    } catch {
      // skip malformed lines
    }
  }
  for (const [id, latestRecord] of latest) {
    const latestTs = recordTimestamp(latestRecord);
    if (latestTs == null) continue;
    const records = history.get(id) ?? [];
    const legacyParseFailuresBeforeLatest = records.filter((record) => {
      const ts = recordTimestamp(record);
      return ts != null && ts <= latestTs && latestTs - ts < PARSE_FAIL_WINDOW_SECONDS && isLegacyParseFailure(record);
    });
    const recentLegacyParseFailures = legacyParseFailuresBeforeLatest.filter(
      (record) => nowSeconds - (recordTimestamp(record) ?? nowSeconds) < PARSE_FAIL_WINDOW_SECONDS,
    );
    const latestAge = nowSeconds - latestTs;
    const latestTtl = Number(latestRecord.ttl_seconds ?? SEEN_TWEET_TTL_SECONDS);
    const legacyParseTerminal =
      latestRecord.outcome == null &&
      latestRecord.attempts == null &&
      latestRecord.ttl_seconds === SEEN_TWEET_TTL_SECONDS &&
      legacyParseFailuresBeforeLatest.length > 0;
    const effectiveTtl = legacyParseTerminal ? Math.min(latestTtl, 60 * 60) : latestTtl;
    if (isCelebritySeenRecordActive({ ...latestRecord, ttl_seconds: effectiveTtl }, nowSeconds)) active.add(id);

    if (latestRecord.outcome === "parse_failed" && latestAge < PARSE_FAIL_WINDOW_SECONDS) {
      const attempts = Math.max(1, Math.floor(Number(latestRecord.attempts) || 1));
      parseFails.set(id, attempts);
    } else if (recentLegacyParseFailures.length > 0) {
      parseFails.set(id, recentLegacyParseFailures.length);
    }
  }
  return { active, parseFails };
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

async function loadSeenState(): Promise<{ active: Set<string>; parseFails: Map<string, number> }> {
  try {
    const raw = await readFile(SEEN_TWEETS_DB, "utf8");
    return parseSeenStateLines(raw.split(/\r?\n/).filter(Boolean), Date.now() / 1000);
  } catch {
    return { active: new Set(), parseFails: new Map() };
  }
}

interface SeenMarkOptions {
  ttlSeconds?: number;
  outcome?: string;
  attempts?: number;
}

async function persistSeen(tid: string, options: SeenMarkOptions = {}): Promise<void> {
  await mkdir(dirname(SEEN_TWEETS_DB), { recursive: true });
  const record: SeenTweetRecord = {
    id: tid,
    ts: Date.now() / 1000,
    ttl_seconds: options.ttlSeconds ?? SEEN_TWEET_TTL_SECONDS,
  };
  if (options.outcome) record.outcome = options.outcome;
  if (options.attempts != null) record.attempts = options.attempts;
  await appendFile(SEEN_TWEETS_DB, `${JSON.stringify(record)}\n`, "utf8");
}

export type CelebrityFetchRunner = (args: string[], timeoutMs?: number) => Promise<CliRunResult<unknown[]>>;

function safeCollectionReason(reason: unknown): string {
  const compact = String(reason ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return compact ? compact.slice(0, 180) : "unknown collection failure";
}

export async function fetchTweets(
  username: string,
  fetchLimit: number,
  runner: CelebrityFetchRunner = runOpencli,
): Promise<Array<Record<string, unknown>>> {
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
  let lastReason = "no usable tweet rows";
  for (let attempt = 0; attempt < 3; attempt++) {
    let opened: CliRunResult<unknown[]>;
    let evalResult: CliRunResult<unknown[]>;
    try {
      await runner(["browser", TWITTER_SEARCH_SESSION, "close"], 10_000);
      opened = await runner(["browser", TWITTER_SEARCH_SESSION, "--window", "background", "open", url], 30_000);
      if (!opened.ok) {
        lastReason = safeCollectionReason(opened.error ?? "open failed");
        continue;
      }
      const waited = await runner(
        ["browser", TWITTER_SEARCH_SESSION, "--window", "background", "wait", "time", "5"],
        10_000,
      );
      if (!waited.ok) {
        lastReason = safeCollectionReason(waited.error ?? "wait failed");
        continue;
      }
      evalResult = await runner(["browser", TWITTER_SEARCH_SESSION, "--window", "background", "eval", js], 30_000);
      if (!evalResult.ok) {
        lastReason = safeCollectionReason(evalResult.error ?? "eval failed");
        continue;
      }
    } catch (err) {
      lastReason = safeCollectionReason(err instanceof Error ? err.message : err);
      continue;
    }

    const page = evalResult.data.find(
      (row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row),
    );
    const classified = classifyCelebritySearchSnapshot(username, page ?? { url });
    if (classified.status === "no-results") return [];
    if (classified.status === "auth-required" || classified.status === "challenge") {
      throw new Error(`celebrity collection @${username} ${classified.status}: ${classified.detail}`);
    }
    if (classified.status !== "ok") {
      lastReason = `${classified.status}: ${safeCollectionReason(classified.detail)}`;
      continue;
    }
    const tweets = Array.isArray(page?.tweets) ? page.tweets : [];
    const rows = tweets.filter(
      (row): row is Record<string, unknown> =>
        Boolean(row) && typeof row === "object" && !Array.isArray(row) && Boolean(String(row.id ?? "").trim()),
    );
    if (rows.length) return rows;
    lastReason = `${classified.status}: no usable tweet rows`;
  }
  throw new Error(`celebrity collection @${username} failed after 3 attempts: ${lastReason}`);
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
  const result = await runAgent(prompt, { timeoutMs: 45_000, task: "celebrity_extract", required: true });
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

/** Built-in Chinese / informal name → ticker aliases (config may override/merge). */
export const DEFAULT_CELEBRITY_ASSET_ALIASES: Record<string, string> = {
  长鑫科技: "CXMT",
  长鑫: "CXMT",
  长鑫存储: "CXMT",
};

/** Built-in account tier map; config `account_tiers` merges on top. */
export const DEFAULT_CELEBRITY_ACCOUNT_TIERS: Record<string, string> = {
  _FORAB: "news",
};

export const CELEBRITY_ENTITY_COOLDOWN_SECONDS = 14_400;

const ASSET_SUFFIX_RE = /(?:合约|股票|概念)$/u;
const TICKER_LIKE_RE = /^[A-Za-z0-9.]{1,10}$/;

/**
 * Normalize celebrity entity strings to a stable asset ticker when possible.
 * - trim; strip trailing 合约/股票/概念
 * - alias lookup (case-insensitive for latin keys; exact for CJK)
 * - bare ticker-like tokens uppercased; otherwise return cleaned raw
 */
export function normalizeCelebrityAsset(raw: string, aliases: Record<string, string> = {}): string {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  s = s.replace(ASSET_SUFFIX_RE, "").trim();
  if (!s) return "";

  const merged: Record<string, string> = { ...DEFAULT_CELEBRITY_ASSET_ALIASES, ...aliases };
  // Exact match first (covers CJK keys).
  if (Object.hasOwn(merged, s)) return merged[s]!;
  const lower = s.toLowerCase();
  for (const [key, ticker] of Object.entries(merged)) {
    if (key.toLowerCase() === lower) return ticker;
  }

  if (TICKER_LIKE_RE.test(s)) return s.toUpperCase();
  return s;
}

/** Stable slug for entity cooldown keys (alnum + underscore). */
export function celebrityAssetSlug(asset: string): string {
  const cleaned = String(asset ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff.]+/gi, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "unknown";
}

export function mergeCelebrityAssetAliases(configAliases: unknown): Record<string, string> {
  const out: Record<string, string> = { ...DEFAULT_CELEBRITY_ASSET_ALIASES };
  if (configAliases && typeof configAliases === "object" && !Array.isArray(configAliases)) {
    for (const [k, v] of Object.entries(configAliases as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
    }
  }
  return out;
}

export function mergeCelebrityAccountTiers(configTiers: unknown): Record<string, string> {
  const out: Record<string, string> = { ...DEFAULT_CELEBRITY_ACCOUNT_TIERS };
  if (configTiers && typeof configTiers === "object" && !Array.isArray(configTiers)) {
    for (const [k, v] of Object.entries(configTiers as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) out[k] = v.trim().toLowerCase();
    }
  }
  return out;
}

export function resolveCelebrityAccountTier(account: string, tiers: Record<string, string>): string {
  const raw = String(account ?? "").replace(/^@/, "");
  if (Object.hasOwn(tiers, raw)) return tiers[raw]!;
  const lower = raw.toLowerCase();
  for (const [key, tier] of Object.entries(tiers)) {
    if (key.toLowerCase() === lower) return tier;
  }
  return "";
}

export function celebrityEntityCooldownKey(account: string, normalizedAsset: string): string {
  return `celebrity_${String(account).replace(/^@/, "")}_${celebrityAssetSlug(normalizedAsset)}`;
}

/**
 * Dual cooldown gate: per-tweet + per (account, entity).
 * Returns why a tweet was blocked so the caller can still markSeen.
 */
export function gateCelebrityTweetAlert(
  state: AlertState,
  tid: string,
  account: string,
  normalizedAsset: string,
): "emit" | "skip_tweet_cd" | "skip_entity_cd" {
  const tweetKey = `t_${tid}`;
  if (!state.canAlert(tweetKey, 600)) return "skip_tweet_cd";
  const entityKey = celebrityEntityCooldownKey(account, normalizedAsset);
  if (!state.canAlert(entityKey, CELEBRITY_ENTITY_COOLDOWN_SECONDS)) return "skip_entity_cd";
  return "emit";
}

export function createCelebrityAlert(input: {
  alphaType: string;
  confidence: number;
  severity: Alert["severity"];
  title: string;
  detail: string;
  timestamp?: string;
  asset: string;
  tokenContract: string;
  tokenChain: string;
  tags: string[];
  cooldownKey?: string;
  /** Force direction (e.g. news tier → 0). */
  direction?: number;
}): Alert {
  const direction = input.direction != null ? input.direction : input.alphaType === "policy" ? 0 : 1;
  return createAlert({
    ruleId: "celebrity",
    severity: input.severity,
    title: input.title,
    detail: input.detail,
    timestamp: input.timestamp,
    direction,
    strength: input.confidence,
    asset: input.asset,
    tokenContract: input.tokenContract,
    tokenChain: input.tokenChain,
    tags: input.tags,
    cooldownKey: input.cooldownKey,
  });
}

export interface CelebrityTweetCandidate {
  account: string;
  tweet: Record<string, unknown>;
  id: string;
  text: string;
  discoveryIndex: number;
}

export function celebrityClassificationLimit(raw: unknown): number {
  const parsed = typeof raw === "string" && !raw.trim() ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed)) return 8;
  return Math.min(50, Math.max(1, Math.trunc(parsed)));
}

function tweetCreatedAtMs(candidate: CelebrityTweetCandidate): number | null {
  const raw = String(candidate.tweet.created_at ?? "").trim();
  if (!raw) return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function selectCelebrityCandidates(
  candidates: CelebrityTweetCandidate[],
  maxClassifications: number,
): { selected: CelebrityTweetCandidate[]; overflow: CelebrityTweetCandidate[] } {
  const ordered = [...candidates].sort((left, right) => {
    const leftTs = tweetCreatedAtMs(left);
    const rightTs = tweetCreatedAtMs(right);
    if (leftTs != null && rightTs != null && leftTs !== rightTs) return rightTs - leftTs;
    if (leftTs != null && rightTs == null) return -1;
    if (leftTs == null && rightTs != null) return 1;
    return left.discoveryIndex - right.discoveryIndex;
  });
  const limit = celebrityClassificationLimit(maxClassifications);
  return { selected: ordered.slice(0, limit), overflow: ordered.slice(limit) };
}

export function createRuleTCelebrity(): AlertRule {
  let seen = new Set<string>();
  let parseFails = new Map<string, number>();
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
      const maxClassifications = celebrityClassificationLimit(cfg.max_classifications_per_tick ?? 8);
      const minConfidenceAlert = clampConfidence(
        cfg.min_confidence_alert ?? DEFAULT_MIN_CONFIDENCE_ALERT,
        DEFAULT_MIN_CONFIDENCE_ALERT,
      );
      const minConfidenceWarning = clampConfidence(
        cfg.min_confidence_warning ?? DEFAULT_MIN_CONFIDENCE_WARNING,
        DEFAULT_MIN_CONFIDENCE_WARNING,
      );
      const assetAliases = mergeCelebrityAssetAliases(cfg.asset_aliases);
      const accountTiers = mergeCelebrityAccountTiers(cfg.account_tiers);
      const seenState = await loadSeenState();
      seen = seenState.active;
      parseFails = seenState.parseFails;

      const alerts: Alert[] = [];
      const candidates: CelebrityTweetCandidate[] = [];
      const candidateIds = new Set<string>();
      let discoveryIndex = 0;
      const markSeen = async (tid: string, options: SeenMarkOptions = {}) => {
        seen.add(tid);
        await persistSeen(tid, options);
      };

      for (const user of accounts) {
        for (const tw of await fetchTweets(user, fetchLimit)) {
          const tid = String(tw.id ?? "");
          if (!tid || seen.has(tid) || candidateIds.has(tid)) continue;
          const text = String(tw.text ?? "").trim();
          if (text.length < 10) {
            await markSeen(tid);
            continue;
          }
          if (isLikelyTweetUiFragment(text, user)) {
            await markSeen(tid);
            continue;
          }

          candidateIds.add(tid);
          candidates.push({ account: user, tweet: tw, id: tid, text, discoveryIndex });
          discoveryIndex += 1;
        }
      }

      const { selected } = selectCelebrityCandidates(candidates, maxClassifications);
      const classified: Array<{ candidate: CelebrityTweetCandidate; decision: CelebrityAlphaDecision }> = [];
      for (const candidate of selected) {
        // Do not persist partial outcomes if a later required classification fails.
        const decision = await extractEntities(candidate.text, candidate.account, minConfidenceAlert);
        classified.push({ candidate, decision });
      }

      for (const { candidate, decision } of classified) {
        const { account: user, tweet: tw, id: tid, text } = candidate;
        const { entities, meta } = decision;
        if (meta.parse_failed) {
          const attempts = (parseFails.get(tid) ?? 0) + 1;
          parseFails.set(tid, attempts);
          const ttl = parseFailMarkTtl(attempts);
          process.stderr.write(`[celebrity] parse_failed id=${tid} attempt=${attempts} retry_in=${ttl}s\n`);
          await markSeen(tid, { ttlSeconds: ttl, outcome: "parse_failed", attempts });
          continue;
        }
        if (!meta.is_alpha || !entities.length) {
          await markSeen(tid, { ttlSeconds: NON_ALPHA_SEEN_SECONDS, outcome: "non_alpha" });
          continue;
        }
        const normalizedAsset = normalizeCelebrityAsset(entities[0] ?? "", assetAliases);
        const gate = gateCelebrityTweetAlert(state, tid, user, normalizedAsset);
        if (gate !== "emit") {
          // Tweet or entity cooldown: still markSeen so we do not re-classify.
          await markSeen(tid);
          continue;
        }
        const celebrityCooldownKey = `t_${tid}`;

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

        const accountTierResolved = resolveCelebrityAccountTier(user, accountTiers);
        const isNewsTier = accountTierResolved === "news";
        let severity = celebrityAlertSeverity(alphaType, entities.length, confidence, minConfidenceWarning);
        if (isNewsTier) severity = "info";

        const primaryRef = chainRefs[0];
        alerts.push(
          createCelebrityAlert({
            alphaType,
            confidence,
            severity,
            title,
            cooldownKey: celebrityCooldownKey,
            detail: lines.join("\n"),
            timestamp: nowDisplay(),
            asset: normalizedAsset,
            tokenContract: primaryRef?.address ?? "",
            tokenChain: primaryRef?.chain ?? "",
            tags: ["celebrity", "llm_autonomous", `conf_${confidence.toFixed(2)}`],
            direction: isNewsTier ? 0 : undefined,
          }),
        );
        await markSeen(tid);
      }
      return alerts;
    },
  };
}
