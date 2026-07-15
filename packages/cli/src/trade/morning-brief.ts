import { dotGet, loadTradeConfig } from "./config.js";
import { okxGet, runOnchainos, runTg, surfFundingRate, surfMarketTicker } from "./data-helpers.js";
import { batchSummarize, stripMarkdown } from "./llm-summarize.js";
import { getScratchpad, type MarketRegime } from "./scratchpad.js";
import { chunkTelegramMessage, sendTelegram } from "./telegram.js";
import { formatDisplayShortTime, formatDisplayTime } from "./time-utils.js";
import { fetchStocksSection } from "./morning-brief-stocks.js";
import { fetchTreasurySection } from "./morning-brief-treasury.js";
import { runTwitterCollector } from "./twitter-collector.js";
import {
  countRecentCacheRecords,
  defaultTwitterCachePath,
  engagementScore,
  entryTimestamp,
  formatTweetLine,
  iterCacheRecords,
  type TwitterCacheEntry,
} from "./twitter-cache.js";
import { llmSummarize } from "./llm-summarize.js";
import {
  buildLeaderboardCliArgs,
  buildPumpfunCliArgs,
  formatLeaderboardSection,
  formatPumpfunSection,
} from "./morning-brief-onchain.js";

export type BriefSection = "market" | "stocks" | "treasury" | "twitter" | "telegram" | "leaderboard" | "pumpfun";

const SECTION_FETCHERS: Record<BriefSection, (hours: number) => Promise<string>> = {
  market: fetchMarketOverview,
  stocks: async () => fetchStocksSection(),
  treasury: async () => fetchTreasurySection(),
  telegram: fetchTelegramSummary,
  twitter: fetchTwitterSummary,
  leaderboard: fetchLeaderboard,
  pumpfun: fetchPumpfun,
};

export function isBriefSection(section: string): section is BriefSection {
  return section in SECTION_FETCHERS;
}

async function fetchMarketOverview(): Promise<string> {
  const config = await loadTradeConfig();
  const ds = (dotGet(config, "data_sources.market", {}) ?? {}) as Record<string, unknown>;
  const instruments = (ds.instruments as string[] | undefined) ?? ["BTC-USDT", "ETH-USDT", "SOL-USDT"];
  const showFr = ds.show_funding_rate !== false;
  const showOi = ds.show_open_interest !== false;
  const requestTimeoutMs = positiveInt(ds.request_timeout_ms, 4_000);
  const fallbackTimeoutMs = positiveInt(ds.fallback_timeout_ms, 5_000);
  const lines = ["📊 市场概览\n"];

  const rows = await Promise.all(
    instruments.map((inst) => fetchMarketInstrument(inst, { showFr, showOi, requestTimeoutMs, fallbackTimeoutMs })),
  );
  lines.push(...rows.map((row) => row.line));
  return lines.join("\n");
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}

export function formatChangePct(pct: number, digits = 1): string {
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(digits)}%`;
}

export function marketRegimeLabel(regime: MarketRegime): string {
  const labels: Record<MarketRegime, string> = {
    risk_on: "风险偏好",
    risk_off: "避险",
    neutral: "中性",
    volatile: "高波动",
  };
  return labels[regime];
}

function successfulBriefSectionParts(parts: string[]): string[] {
  return parts.slice(1).filter((part) => part.length > 0 && !part.startsWith("["));
}

export function shouldGenerateDailySummary(config: Record<string, unknown>, parts: string[]): boolean {
  return (
    dotGet(config, "briefing.daily_summary", true) !== false &&
    dotGet(config, "briefing.llm_summarize", true) !== false &&
    successfulBriefSectionParts(parts).length >= 2
  );
}

async function fetchMarketInstrument(
  inst: string,
  options: { showFr: boolean; showOi: boolean; requestTimeoutMs: number; fallbackTimeoutMs: number },
): Promise<{ line: string }> {
  const symbol = inst.split("-")[0]!;
  const swapId = `${symbol}-USDT-SWAP`;
  const emptyRecord: Record<string, unknown> = {};
  const [tickerResp, frResp, oiResp] = await Promise.all([
    okxGet("/api/v5/market/ticker", { instId: inst }, options.requestTimeoutMs, 1),
    options.showFr
      ? okxGet("/api/v5/public/funding-rate", { instId: swapId }, options.requestTimeoutMs, 1)
      : Promise.resolve(emptyRecord),
    options.showOi
      ? okxGet("/api/v5/public/open-interest", { instType: "SWAP", instId: swapId }, options.requestTimeoutMs, 1)
      : Promise.resolve(emptyRecord),
  ]);

  const ticker = ((tickerResp.data as unknown[])?.[0] ?? {}) as Record<string, string>;
  const fr = ((frResp.data as unknown[])?.[0] ?? {}) as Record<string, string>;
  const oi = ((oiResp.data as unknown[])?.[0] ?? {}) as Record<string, string>;
  let last = ticker.last ?? "";
  let open24 = ticker.open24h ?? "";
  let rate = fr.fundingRate ?? "";

  if (!last || (options.showFr && !rate)) {
    const [surfTicker, surfFr] = await Promise.all([
      !last ? surfMarketTicker(symbol, options.fallbackTimeoutMs) : Promise.resolve(emptyRecord),
      options.showFr && !rate ? surfFundingRate(symbol, options.fallbackTimeoutMs) : Promise.resolve(emptyRecord),
    ]);
    if (!last) {
      last = String(surfTicker.last ?? "");
      open24 = String(surfTicker.open24h ?? "");
    }
    if (options.showFr && !rate) rate = String(surfFr.fundingRate ?? "");
  }

  let priceStr = "N/A";
  let changeStr = "";
  const lastN = Number.parseFloat(last);
  const openN = Number.parseFloat(open24);
  if (Number.isFinite(lastN)) priceStr = `$${lastN.toLocaleString()}`;
  if (Number.isFinite(lastN) && Number.isFinite(openN) && openN > 0) {
    changeStr = ` (${formatChangePct(((lastN - openN) / openN) * 100)})`;
  }

  let frStr = "";
  const rateN = Number.parseFloat(rate);
  if (options.showFr && Number.isFinite(rateN)) frStr = `  费率: ${(rateN * 100).toFixed(4)}%`;

  let oiStr = "";
  const oiN = Number.parseFloat(oi.oiCcy ?? "");
  if (options.showOi && Number.isFinite(oiN)) oiStr = `  OI: ${oiN.toLocaleString()} ${symbol}`;

  const tickerTime = Number.parseInt(ticker.ts ?? "", 10);
  const asOf = Number.isFinite(tickerTime) && tickerTime > 0 ? new Date(tickerTime) : undefined;
  const timeStr = asOf ? ` @${formatDisplayShortTime(asOf)}` : "";
  return { line: `  ${symbol}: ${priceStr}${changeStr}${frStr}${oiStr}${timeStr}` };
}

export function parseTelegramChannels(raw: Record<string, string>): Array<{ label: string; chat: string }> {
  return Object.entries(raw).map(([label, chat]) => ({ label, chat }));
}

function extractTgMessagesFromYaml(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("---")) continue;
    for (const prefix of ["content:", "- content:", "text:", "- text:"]) {
      if (s.startsWith(prefix)) {
        const text = s
          .slice(prefix.length)
          .trim()
          .replace(/^["']|["']$/g, "");
        if (text) out.push(text);
        break;
      }
    }
  }
  return out;
}

export function parseTgRecentMessages(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as { data?: Array<{ content?: string }> };
    return (parsed.data ?? []).map((m) => String(m.content ?? "").trim()).filter(Boolean);
  } catch {
    return extractTgMessagesFromYaml(raw);
  }
}

export function preprocessTelegramBody(text: string, maxLines = 40): string {
  const lines = stripMarkdown(text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line !== "⚙️");
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const line of lines) {
    const normalized = line.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    picked.push(line);
    if (picked.length >= maxLines) break;
  }
  return picked.join("\n");
}

export interface ChainFmReference {
  kind: "token" | "account";
  label: string;
  chain: string;
  address: string;
}

const CHAIN_FM_MARKDOWN_LINK_RE = /\[([^\]]+)\]\((https:\/\/chain\.fm\/(?:token|account)\/[^)\s]+)\)/g;

function parseChainFmReference(label: string, rawUrl: string): ChainFmReference | undefined {
  try {
    const url = new URL(rawUrl);
    const [kind, chain, address] = url.pathname.split("/").filter(Boolean);
    if ((kind !== "token" && kind !== "account") || !chain || !address) return undefined;
    return { kind, label: label.trim(), chain, address: decodeURIComponent(address) };
  } catch {
    return undefined;
  }
}

export function extractChainFmReferences(text: string): ChainFmReference[] {
  const references: ChainFmReference[] = [];
  for (const match of text.matchAll(CHAIN_FM_MARKDOWN_LINK_RE)) {
    const reference = parseChainFmReference(match[1] ?? "", match[2] ?? "");
    if (reference) references.push(reference);
  }
  return references;
}

export function expandChainFmReferences(text: string): string {
  return text.replace(CHAIN_FM_MARKDOWN_LINK_RE, (markdown, label: string, rawUrl: string) => {
    const reference = parseChainFmReference(label, rawUrl);
    if (!reference) return markdown;
    const chain = reference.chain.toUpperCase();
    if (reference.kind === "token") return `${label}（${chain} 合约 ${reference.address}）`;
    if (label.includes("...")) return `${label}（${chain} 完整地址 ${reference.address}）`;
    return label;
  });
}

export function formatMemeAddressIndex(summary: string, references: ChainFmReference[]): string {
  const selected = references.filter((reference) => {
    const label = reference.label.trim();
    if (label.length < 2 || !/[A-Za-z一-鿿]/.test(label)) return false;
    if (!summaryMentionsReference(summary, reference.label)) return false;
    return reference.kind === "token" || reference.label.includes("...");
  });
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const reference of selected) {
    const key = `${reference.kind}:${reference.chain}:${reference.address}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const descriptor = reference.kind === "token" ? "合约" : "完整地址";
    lines.push(`${reference.label} · ${reference.chain.toUpperCase()} ${descriptor} · ${reference.address}`);
  }
  return lines.length ? `合约/地址索引：\n${lines.join("\n")}` : "";
}

function summaryMentionsReference(summary: string, label: string): boolean {
  const normalizedLabel = label.trim();
  if (!normalizedLabel) return false;
  if (/^[A-Za-z0-9_$]+$/.test(normalizedLabel)) {
    const escaped = normalizedLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, "i").test(summary);
  }
  return summary.toLowerCase().includes(normalizedLabel.toLowerCase());
}

export function resolveBriefingPushTg(config: Record<string, unknown>, options: { pushTg?: boolean } = {}): boolean {
  if (options.pushTg === true) return true;
  if (options.pushTg === false) return false;
  return dotGet(config, "briefing.push_telegram", false) === true;
}

export interface TwitterSummaryFunnel {
  cached: number;
  filtered: number;
  analyzed: number;
}

export interface TwitterSummaryCandidate {
  entry: TwitterCacheEntry;
  formatted: string;
}

export function rankTwitterCandidates(candidates: TwitterSummaryCandidate[]): TwitterSummaryCandidate[] {
  return [...candidates].sort((a, b) => {
    const scoreDiff = engagementScore(b.formatted) - engagementScore(a.formatted);
    if (scoreDiff) return scoreDiff;
    const timeDiff = (entryTimestamp(b.entry)?.getTime() ?? 0) - (entryTimestamp(a.entry)?.getTime() ?? 0);
    if (timeDiff) return timeDiff;
    return String(b.entry.id ?? "").localeCompare(String(a.entry.id ?? ""));
  });
}

export function buildTwitterQuickList(tweets: TwitterSummaryCandidate[], size: number): string[] {
  if (!tweets.length || !Number.isFinite(size) || size <= 0) return [];
  const shown = Math.min(Math.trunc(size), tweets.length);
  if (shown <= 0) return [];
  return [
    `⚡ 高互动推文速览（Top ${shown}，按互动排序）`,
    ...tweets.slice(0, shown).map((tweet) => `  ${formatTweetLine(tweet.entry, { maxTextChars: 140 })}`),
  ];
}

export function formatTwitterSummaryHeading(hours: number, funnel?: TwitterSummaryFunnel, summarized = true): string {
  if (!funnel) return `🐦 Twitter 时间线（最近 ${hours}h）\n`;
  const detail = summarized
    ? `缓存 ${funnel.cached} 条，筛后 ${funnel.filtered} 条，已分析 ${funnel.analyzed} 条`
    : `缓存 ${funnel.cached} 条，筛后 ${funnel.filtered} 条，展示 ${funnel.analyzed} 条高相关推文`;
  return `🐦 Twitter 时间线（最近 ${hours}h，${detail}）\n`;
}

export function formatTwitterSourceNotes(summary: string, candidates: TwitterCacheEntry[]): string[] {
  const ids = [...summary.matchAll(/\[T(\d+)\]/g)]
    .map((match) => Number.parseInt(match[1] ?? "", 10))
    .filter((id, index, all) => id >= 1 && id <= candidates.length && all.indexOf(id) === index);
  return ids.map((id) => {
    const entry = candidates[id - 1]!;
    const author = String(entry.author ?? "unknown").replace(/^@/, "");
    const timestamp = entryTimestamp(entry);
    const time = timestamp ? formatDisplayShortTime(timestamp) : "时间未知";
    const tweetId = String(entry.id ?? "");
    const url =
      String(entry.url ?? "") ||
      (author !== "unknown" && tweetId ? `https://x.com/${author}/status/${tweetId}` : "链接缺失");
    return `[T${id}] @${author} · ${time} · ${url}`;
  });
}

type TgChannelFetch = {
  messages: string[];
  rawBytes: number;
  usedHours?: number;
  stale?: boolean;
  error?: string;
};

async function fetchTgChannelMessages(
  chat: string,
  hours: number,
  msgLimit: number,
  fallbackHours: number,
): Promise<TgChannelFetch> {
  const hourAttempts = [...new Set([hours, fallbackHours].filter((h) => Number.isFinite(h) && h > 0))];
  let lastBytes = 0;
  for (let i = 0; i < hourAttempts.length; i++) {
    const h = hourAttempts[i]!;
    const result = await runTg([
      "recent",
      "-c",
      chat,
      "-n",
      String(msgLimit),
      "--hours",
      String(h),
      ...(i === 0 ? ["--sync-first"] : []),
      "--json",
    ]);
    if (!result.ok) return { messages: [], rawBytes: 0, error: result.error };
    lastBytes = result.data.length;
    const messages = parseTgRecentMessages(result.data);
    if (messages.length) {
      return {
        messages,
        rawBytes: lastBytes,
        usedHours: h,
        stale: h > hours,
      };
    }
  }

  const fallback = await runTg(["recent", "-c", chat, "-n", String(msgLimit), "--json"]);
  if (!fallback.ok) return { messages: [], rawBytes: lastBytes, error: fallback.error };
  const messages = parseTgRecentMessages(fallback.data);
  return {
    messages,
    rawBytes: fallback.data.length || lastBytes,
    stale: messages.length > 0,
  };
}

async function fetchTwitterSummary(hours: number): Promise<string> {
  const config = await loadTradeConfig();
  const ds = (dotGet(config, "data_sources.twitter", {}) ?? {}) as Record<string, unknown>;
  const cachePath = String(ds.cache_path ?? defaultTwitterCachePath());
  const authorBlocklist = new Set(
    ((ds.author_blocklist as string[] | undefined) ?? []).map((s) => s.toLowerCase().replace(/^@/, "")),
  );
  const maxDisplay = Number(ds.max_display) || 500;
  const llmMaxDisplay = positiveInt(ds.llm_max_display, 150);
  const quickListSize = nonNegativeInt(ds.quick_list_size, 10);
  const perAuthorCap = Number(ds.per_author_cap) || 2;
  const relevanceFilter = ds.relevance_filter !== false;
  const useLlm = dotGet(config, "briefing.llm_summarize", true) !== false;
  const cutoff = Date.now() - hours * 3600 * 1000;
  const lines: string[] = [formatTwitterSummaryHeading(hours)];

  let cacheStats = await countRecentCacheRecords(hours, cachePath);
  if (cacheStats.recent === 0) {
    process.stderr.write("[morning-brief] twitter cache empty/stale; running collector...\n");
    try {
      await runTwitterCollector(cachePath);
      cacheStats = await countRecentCacheRecords(hours, cachePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[morning-brief] twitter collector failed: ${msg}\n`);
    }
  }

  const tweets: Array<{ entry: TwitterCacheEntry; formatted: string }> = [];
  let totalRecords = 0;
  let staleRecords = 0;
  let invalidTimeRecords = 0;
  let filteredRecords = 0;

  for await (const entry of iterCacheRecords(cachePath)) {
    totalRecords += 1;
    const author = String(entry.author ?? "").toLowerCase();
    if (author && authorBlocklist.has(author)) continue;
    const ts = entryTimestamp(entry);
    if (!ts) {
      invalidTimeRecords += 1;
      continue;
    }
    if (ts.getTime() < cutoff) {
      staleRecords += 1;
      continue;
    }
    if (relevanceFilter && !isTradeRelevantTweet(String(entry.text ?? ""))) {
      filteredRecords += 1;
      continue;
    }
    const formatted = formatTweetLine(entry);
    if (formatted) tweets.push({ entry, formatted });
  }

  if (!tweets.length) {
    lines[0] = formatTwitterSummaryHeading(hours, { cached: cacheStats.recent, filtered: 0, analyzed: 0 }, useLlm);
    const diagnostics = totalRecords
      ? `缓存 ${totalRecords} 条，过期 ${staleRecords} 条，时间异常 ${invalidTimeRecords} 条`
      : `缓存为空或不存在：${cachePath}`;
    const filterNote = filteredRecords ? `，过滤低相关 ${filteredRecords} 条` : "";
    lines.push(`暂无高相关推文（${diagnostics}${filterNote}；需运行 twitter-collector 或检查 opencli 登录状态）`);
    return lines.join("\n");
  }

  const sorted = rankTwitterCandidates(tweets);
  const displayedTweets = useLlm
    ? pickTwitterDisplayTweets(sorted, Math.min(maxDisplay, llmMaxDisplay), perAuthorCap)
    : pickTwitterDisplayTweets(sorted, maxDisplay, perAuthorCap);
  const displayedEntries = displayedTweets.map((tweet) => tweet.entry);
  lines[0] = formatTwitterSummaryHeading(
    hours,
    { cached: cacheStats.recent, filtered: tweets.length, analyzed: displayedTweets.length },
    useLlm,
  );

  if (useLlm) {
    const summaryInput = displayedTweets.map((tweet, index) => `[T${index + 1}] ${tweet.formatted}`).join("\n");
    const summary = await llmSummarize(
      summaryInput,
      "Twitter 时间线（只保留交易、宏观、加密、AI芯片、上市公司与监管相关信息）",
      "最多输出 5 条，按市场影响排序。每条末尾必须原样保留对应的 [Tn] 引用；区分官方消息与二手转述，不得把二手转述写成已证实事实。不要输出体育、促销、账号服务、VPN、信用卡或交易信号广告。",
      { maxInputChars: null, timeoutMs: 120_000 },
    );
    const sourceNotes = formatTwitterSourceNotes(summary, displayedEntries);
    if (sourceNotes.length) {
      lines.push(summary, `\n来源索引：\n${sourceNotes.join("\n")}`);
    } else {
      const fallback = displayedTweets.slice(0, 5).map((tweet, index) => {
        const text = tweet.formatted.length > 240 ? `${tweet.formatted.slice(0, 239)}…` : tweet.formatted;
        return `${index + 1}. ${text} [T${index + 1}]`;
      });
      const fallbackSummary = fallback.join("\n");
      lines.push(
        fallbackSummary,
        `\n来源索引：\n${formatTwitterSourceNotes(fallbackSummary, displayedEntries).join("\n")}`,
      );
    }
    const quickList = buildTwitterQuickList(displayedTweets, quickListSize);
    if (quickList.length) lines.push("", ...quickList);
  } else {
    lines.push(...displayedTweets.map((tweet) => tweet.formatted));
  }
  return lines.join("\n");
}

export function pickTwitterDisplayTweets(
  tweets: TwitterSummaryCandidate[],
  maxDisplay: number,
  perAuthorCap: number,
): TwitterSummaryCandidate[] {
  const authorCount = new Map<string, number>();
  const picked: TwitterSummaryCandidate[] = [];
  for (const tweet of tweets) {
    if (picked.length >= maxDisplay) break;
    const author = tweet.formatted.match(/^@(\S+?):/)?.[1] ?? "";
    if (author) {
      const count = authorCount.get(author) ?? 0;
      if (count >= perAuthorCap) continue;
      authorCount.set(author, count + 1);
    }
    picked.push(tweet);
  }
  return picked;
}

const TWITTER_RELEVANT_RE =
  /(\$[A-Za-z]{1,8}\b|\b[A-Z]{2,6}\b|btc|eth|sol|crypto|bitcoin|ethereum|binance|coinbase|okx|bybit|etf|fomc|fed|sec|cpi|pce|tariff|yield|treasury|bond|stock|nasdaq|s&p|dow|ipo|earnings|revenue|profit|guidance|chips?|semiconductor|nvidia|tesla|meta|apple|google|microsoft|openai|deepseek|字节|阿里|英伟达|特斯拉|美联储|降息|加息|通胀|收益率|美债|关税|制裁|监管|证监会|交易所|上新|暴跌|暴涨|爆仓|链上|巨鲸|钱包|代币|加密|比特币|以太坊|山寨|芯片|财报|营收|利润|上市|美股|港股|A股|纳指|标普|道指|股票)/i;
const TWITTER_HARD_NOISE_RE =
  /(世界杯|football|soccer|the beautiful game|leaderboard|bitcoin rewards|outcomes campaign|足球|进球|比利时|信用卡|申卡|返现|hsbc|pulse卡|账号池|七折|relayrouter|vpn|机场|推广|广告|品牌套件|高考分数线|小语种|设备锁定|切换账号|account banned|quota|gopty|tmux|\bfable\b|mythos|竞猜活动|免费试用|free trial|trading signals?|交易信号)/i;
const TWITTER_NOISE_RE = /(活动|抽奖|促销|教程|攻略|开户|办卡)/i;
const TWITTER_NOISE_WITH_MARKET_RE =
  /(证监会|股票|市场|交易|美股|港股|A股|财报|营收|利润|监管|sec|stock|earnings|revenue|crypto|bitcoin|ethereum|币|链上|交易所)/i;

export function isTradeRelevantTweet(text: string): boolean {
  const cleaned = stripMarkdown(text).trim();
  if (!cleaned) return false;
  if (TWITTER_HARD_NOISE_RE.test(cleaned)) return false;
  if (!TWITTER_RELEVANT_RE.test(cleaned)) return false;
  if (TWITTER_NOISE_RE.test(cleaned) && !TWITTER_NOISE_WITH_MARKET_RE.test(cleaned)) return false;
  return true;
}

async function fetchTelegramSummary(hours: number): Promise<string> {
  const config = await loadTradeConfig();
  const useLlm = dotGet(config, "briefing.llm_summarize", true) !== false;
  const channels = (dotGet(config, "telegram.channels", {
    方程式快讯: "方程式新闻 BWEnews",
    "传统金融/宏观": "@BWETradFi |方程式财经（传统金融新闻）",
    "meme 链上监控": "meme链上监控",
  }) ?? {}) as Record<string, string>;
  const msgLimit = Number(dotGet(config, "data_sources.telegram.messages_per_channel", 15)) || 15;
  const fallbackHours = Number(dotGet(config, "briefing.telegram_fallback_hours", 168)) || 168;
  const lines = [`📰 Telegram 频道摘要（最近 ${hours}h）\n`];
  const channelRows = parseTelegramChannels(channels);
  const fetched: Array<{ label: string } & TgChannelFetch> = [];
  for (const { label, chat } of channelRows) {
    const result = await fetchTgChannelMessages(chat, hours, msgLimit, fallbackHours);
    fetched.push({ label, ...result });
  }

  const blocks: Array<{
    label: string;
    text: string;
    instruction?: string;
    addressReferences?: ChainFmReference[];
  }> = [];
  for (const { label, messages, rawBytes, usedHours, stale, error } of fetched) {
    if (error) {
      lines.push(`【${label}】采集失败: ${error}`);
      continue;
    }
    if (!messages.length) {
      lines.push(`【${label}】暂无消息（tg 返回 ${rawBytes} 字节，最近 ${hours}h 与 ${fallbackHours}h 均无内容）`);
      continue;
    }
    const rawBody = messages.join("\n");
    const isMeme = label.toLowerCase().includes("meme");
    const addressReferences = isMeme ? extractChainFmReferences(rawBody) : undefined;
    const body = preprocessTelegramBody(isMeme ? expandChainFmReferences(rawBody) : rawBody);
    const staleNote = stale
      ? `（最近 ${hours}h 无新消息${usedHours ? `，展示最近 ${usedHours}h 内消息` : "，展示最近缓存消息"}）\n`
      : "";
    const instruction = isMeme
      ? "最多 5 条、350 字。优先保留真实买入/卖出、美元价值、流动性、市值和地址集中度；普通转账/空投合并为一条，不要逐个罗列代币。若只有转账而无买盘或估值依据，明确写「不构成交易信号」。涉及代币或转账方时禁止缩写链名、合约地址和钱包地址。"
      : undefined;
    blocks.push({ label, text: body, instruction, addressReferences });
    if (!useLlm) lines.push(`【${label}】${staleNote}${body.slice(0, 1500)}`);
  }

  if (useLlm && blocks.length) {
    const summaries = await batchSummarize(blocks);
    blocks.forEach((b, i) => {
      const fetchedRow = fetched.find((row) => row.label === b.label);
      const staleNote = fetchedRow?.stale
        ? `（最近 ${hours}h 无新消息${fetchedRow.usedHours ? `，展示最近 ${fetchedRow.usedHours}h 内消息` : "，展示最近缓存消息"}）\n`
        : "";
      const compact = compactTelegramSummary(b.label, summaries[i] ?? "");
      const addressIndex = formatMemeAddressIndex(compact, b.addressReferences ?? []);
      lines.push(`【${b.label}】${staleNote}${compact}${addressIndex ? `\n${addressIndex}` : ""}`);
    });
  }
  return lines.join("\n\n");
}

export function compactTelegramSummary(label: string, summary: string): string {
  if (!label.toLowerCase().includes("meme")) return summary;
  const lines = summary
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6);
  const compact = lines.join("\n");
  if (compact.length <= 500) return compact;
  return `${compact.slice(0, 499).trimEnd()}…`;
}

async function fetchLeaderboard(): Promise<string> {
  const config = await loadTradeConfig();
  const useLlm = dotGet(config, "briefing.llm_summarize", true) !== false;
  const ds = (dotGet(config, "data_sources.leaderboard", {}) ?? {}) as Record<string, unknown>;
  const chains = (ds.chains as string[] | undefined) ?? ["solana"];
  const limit = Number(ds.limit) || 5;
  const lines = ["🏆 聪明钱 Leaderboard\n"];
  const blocks: string[] = [];

  for (const chain of chains) {
    const result = await runOnchainos(buildLeaderboardCliArgs(chain, ds));
    if (!result.ok) {
      lines.push(`${chain}: 采集失败: ${result.error}`);
      continue;
    }
    const formatted = formatLeaderboardSection(result.data, limit);
    if (!formatted.length) {
      lines.push(`${chain}: 暂无数据（onchainos 返回空结果）`);
      continue;
    }
    blocks.push(`【${chain}】\n${formatted.join("\n\n")}`);
  }

  if (!blocks.length) return lines.join("\n");

  const body = blocks.join("\n\n");
  if (useLlm) {
    const summary = await llmSummarize(body, "聪明钱 Leaderboard");
    lines.push(summary);
  } else {
    lines.push(body);
  }
  return lines.join("\n");
}

async function fetchPumpfun(): Promise<string> {
  const config = await loadTradeConfig();
  const useLlm = dotGet(config, "briefing.llm_summarize", true) !== false;
  const ds = (dotGet(config, "data_sources.pumpfun", {}) ?? {}) as Record<string, unknown>;
  const result = await runOnchainos(buildPumpfunCliArgs(ds));
  const lines = ["🎰 Pump.fun 热榜\n"];

  if (!result.ok) {
    lines.push(`采集失败: ${result.error}`);
    return lines.join("\n");
  }

  const { stage, lines: formatted } = formatPumpfunSection(result.data, ds);
  if (!formatted.length) {
    lines.push(`暂无符合条件代币（stage=${stage}，已应用质量过滤）`);
    return lines.join("\n");
  }

  const body = formatted.join("\n\n");
  if (useLlm) {
    const summary = await llmSummarize(body, `Pump.fun ${stage}`);
    lines.push(summary);
  } else {
    lines.push(body);
  }
  return lines.join("\n");
}

export async function runMorningBrief(
  options: { sections?: BriefSection[]; hours?: number; pushTg?: boolean; dryRun?: boolean } = {},
): Promise<string> {
  const config = await loadTradeConfig();
  const defaultSections: BriefSection[] = ["stocks", "telegram", "twitter"];
  const enabled = (dotGet(config, "briefing.enabled", defaultSections) as string[] | undefined) ?? defaultSections;
  const sections = options.sections?.length ? options.sections.filter(isBriefSection) : enabled.filter(isBriefSection);
  const hours = options.hours ?? (Number(dotGet(config, "briefing.hours_lookback", 24)) || 24);

  const parts = [`🌅 每日晨报 — ${formatDisplayTime()}\n`];
  for (const section of sections) {
    const fetcher = SECTION_FETCHERS[section];
    if (!fetcher) continue;
    try {
      parts.push(await fetcher(hours));
      parts.push("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      parts.push(`[${section}] 获取失败: ${msg}\n`);
    }
  }

  if (shouldGenerateDailySummary(config, parts)) {
    try {
      const regime = await getScratchpad().getRegime();
      const regimeLabel = marketRegimeLabel(regime);
      const summary = await llmSummarize(
        successfulBriefSectionParts(parts).join("\n\n"),
        "今日要点",
        `已知当前市场状态: ${regimeLabel}(${regime})。综合各板块信息输出最多 3 条要点，每条一行、不超过60字，按市场影响排序；区分官方数据与传闻，不得将传闻写成事实。最后单独一行输出「风险倾向: 偏多/偏空/中性/观望」。`,
        { maxInputChars: 8000, timeoutMs: 120_000 },
      );
      parts.splice(1, 0, `🧭 今日要点（市场状态: ${regimeLabel}(${regime})）\n\n${summary}`, "");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[morning-brief] daily summary failed: ${msg}\n`);
    }
  }

  const output = parts.join("\n");
  process.stdout.write(`${output}\n`);

  if (!options.dryRun) {
    await getScratchpad().write(
      "last_brief",
      { at: new Date().toISOString(), sections },
      { source: "morning_brief", ttlHours: 24 },
    );
  }

  const pushTg = resolveBriefingPushTg(config, options);
  if (pushTg && !options.dryRun) {
    const chunks = chunkTelegramMessage(output).length;
    const ok = await sendTelegram(output, config);
    const status = ok ? "ok" : "failed";
    process.stderr.write(`[morning-brief] telegram push ${status} chunks=${chunks}\n`);
    await getScratchpad().write(
      "last_brief_push",
      { at: new Date().toISOString(), ok, sections, chunks },
      { source: "morning_brief", ttlHours: 24 },
    );
  }

  return output;
}
