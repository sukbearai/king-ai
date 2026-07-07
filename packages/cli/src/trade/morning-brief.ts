import { dotGet, loadTradeConfig } from "./config.js";
import { okxGet, runOnchainos, runTg, surfFundingRate, surfMarketTicker } from "./data-helpers.js";
import { batchSummarize, stripMarkdown } from "./llm-summarize.js";
import { getScratchpad } from "./scratchpad.js";
import { chunkTelegramMessage, sendTelegram } from "./telegram.js";
import { formatDisplayTime } from "./time-utils.js";
import { fetchStocksSection } from "./morning-brief-stocks.js";
import { fetchTreasurySection } from "./morning-brief-treasury.js";
import { runTwitterCollector } from "./twitter-collector.js";
import {
  countRecentCacheRecords,
  defaultTwitterCachePath,
  engagementScore,
  entryTimestamp,
  formatTweetLine,
  iterCacheRecords
} from "./twitter-cache.js";
import { llmSummarize } from "./llm-summarize.js";
import {
  buildLeaderboardCliArgs,
  buildPumpfunCliArgs,
  formatLeaderboardSection,
  formatPumpfunSection
} from "./morning-brief-onchain.js";

export type BriefSection = "market" | "stocks" | "treasury" | "twitter" | "telegram" | "leaderboard" | "pumpfun";

const SECTION_FETCHERS: Record<BriefSection, (hours: number) => Promise<string>> = {
  market: fetchMarketOverview,
  stocks: async () => fetchStocksSection(),
  treasury: async () => fetchTreasurySection(),
  telegram: fetchTelegramSummary,
  twitter: fetchTwitterSummary,
  leaderboard: fetchLeaderboard,
  pumpfun: fetchPumpfun
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
  const lines = ["📊 市场概览\n"];

  for (const inst of instruments) {
    const symbol = inst.split("-")[0]!;
    const resp = await okxGet("/api/v5/market/ticker", { instId: inst });
    const ticker = ((resp.data as unknown[])?.[0] ?? {}) as Record<string, string>;
    let last = ticker.last ?? "";
    let open24 = ticker.open24h ?? "";
    if (!last) {
      const surf = await surfMarketTicker(symbol);
      last = String(surf.last ?? "");
      open24 = String(surf.open24h ?? "");
    }

    let priceStr = "N/A";
    let changeStr = "";
    const lastN = Number.parseFloat(last);
    const openN = Number.parseFloat(open24);
    if (Number.isFinite(lastN)) priceStr = `$${lastN.toLocaleString()}`;
    if (Number.isFinite(lastN) && Number.isFinite(openN) && openN > 0) {
      changeStr = ` (${((lastN - openN) / openN * 100).toFixed(1)}%)`;
    }

    let frStr = "";
    if (showFr) {
      const swapId = `${symbol}-USDT-SWAP`;
      const frResp = await okxGet("/api/v5/public/funding-rate", { instId: swapId });
      const fr = ((frResp.data as unknown[])?.[0] ?? {}) as Record<string, string>;
      let rate = fr.fundingRate ?? "";
      if (!rate) {
        const surfFr = await surfFundingRate(symbol);
        rate = String(surfFr.fundingRate ?? "");
      }
      const rateN = Number.parseFloat(rate);
      if (Number.isFinite(rateN)) frStr = `  费率: ${(rateN * 100).toFixed(4)}%`;
    }

    let oiStr = "";
    if (showOi) {
      const oiResp = await okxGet("/api/v5/public/open-interest", { instType: "SWAP", instId: `${symbol}-USDT-SWAP` });
      const oi = ((oiResp.data as unknown[])?.[0] ?? {}) as Record<string, string>;
      const oiN = Number.parseFloat(oi.oiCcy ?? "");
      if (Number.isFinite(oiN)) oiStr = `  OI: ${oiN.toLocaleString()}`;
    }

    lines.push(`  ${symbol}: ${priceStr}${changeStr}${frStr}${oiStr}`);
  }
  return lines.join("\n");
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
        const text = s.slice(prefix.length).trim().replace(/^["']|["']$/g, "");
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
    return (parsed.data ?? [])
      .map((m) => String(m.content ?? "").trim())
      .filter(Boolean);
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

export function resolveBriefingPushTg(
  config: Record<string, unknown>,
  options: { pushTg?: boolean } = {}
): boolean {
  if (options.pushTg === true) return true;
  if (options.pushTg === false) return false;
  return dotGet(config, "briefing.push_telegram", false) === true;
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
  fallbackHours: number
): Promise<TgChannelFetch> {
  const hourAttempts = [...new Set([hours, fallbackHours].filter((h) => Number.isFinite(h) && h > 0))];
  let lastBytes = 0;
  for (let i = 0; i < hourAttempts.length; i++) {
    const h = hourAttempts[i]!;
    const result = await runTg([
      "recent",
      "-c", chat,
      "-n", String(msgLimit),
      "--hours", String(h),
      ...(i === 0 ? ["--sync-first"] : []),
      "--json"
    ]);
    if (!result.ok) return { messages: [], rawBytes: 0, error: result.error };
    lastBytes = result.data.length;
    const messages = parseTgRecentMessages(result.data);
    if (messages.length) {
      return {
        messages,
        rawBytes: lastBytes,
        usedHours: h,
        stale: h > hours
      };
    }
  }

  const fallback = await runTg([
    "recent",
    "-c", chat,
    "-n", String(msgLimit),
    "--json"
  ]);
  if (!fallback.ok) return { messages: [], rawBytes: lastBytes, error: fallback.error };
  const messages = parseTgRecentMessages(fallback.data);
  return {
    messages,
    rawBytes: fallback.data.length || lastBytes,
    stale: messages.length > 0
  };
}

async function fetchTwitterSummary(hours: number): Promise<string> {
  const config = await loadTradeConfig();
  const ds = (dotGet(config, "data_sources.twitter", {}) ?? {}) as Record<string, unknown>;
  const cachePath = String(ds.cache_path ?? defaultTwitterCachePath());
  const authorBlocklist = new Set(
    ((ds.author_blocklist as string[] | undefined) ?? []).map((s) => s.toLowerCase().replace(/^@/, ""))
  );
  const maxDisplay = Number(ds.max_display) || 500;
  const perAuthorCap = Number(ds.per_author_cap) || 2;
  const relevanceFilter = ds.relevance_filter !== false;
  const useLlm = dotGet(config, "briefing.llm_summarize", true) !== false;
  const cutoff = Date.now() - hours * 3600 * 1000;
  const lines: string[] = [`🐦 Twitter 时间线（最近 ${hours}h）\n`];

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

  const tweets: string[] = [];
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
    if (formatted) tweets.push(formatted);
  }

  if (!tweets.length) {
    const diagnostics = totalRecords
      ? `缓存 ${totalRecords} 条，过期 ${staleRecords} 条，时间异常 ${invalidTimeRecords} 条`
      : `缓存为空或不存在：${cachePath}`;
    const filterNote = filteredRecords ? `，过滤低相关 ${filteredRecords} 条` : "";
    lines.push(`暂无高相关推文（${diagnostics}${filterNote}；需运行 twitter-collector 或检查 opencli 登录状态）`);
    return lines.join("\n");
  }

  const sorted = [...tweets].sort((a, b) => engagementScore(b) - engagementScore(a));
  const authorCount = new Map<string, number>();
  const picked: string[] = [];
  for (const tweet of sorted) {
    if (picked.length >= maxDisplay) break;
    const author = tweet.match(/^@(\S+?):/)?.[1] ?? "";
    if (author) {
      const count = authorCount.get(author) ?? 0;
      if (count >= perAuthorCap) continue;
      authorCount.set(author, count + 1);
    }
    picked.push(tweet);
  }

  if (useLlm) {
    const summaryInput = [
      "只摘要高置信交易相关内容；不要输出体育赛事、竞猜活动、账号服务、免费试用、交易信号广告、VPN/机场、信用卡或泛促销内容。",
      ...picked.slice(0, 30)
    ].join("\n");
    const summary = await llmSummarize(
      summaryInput,
      "Twitter 时间线（只保留交易、宏观、加密、AI芯片、上市公司与监管相关信息）"
    );
    lines.push(summary);
  } else {
    lines.push(...picked.slice(0, 30));
  }
  return lines.join("\n");
}

const TWITTER_RELEVANT_RE = /(\$[A-Za-z]{1,8}\b|\b[A-Z]{2,6}\b|btc|eth|sol|crypto|bitcoin|ethereum|binance|coinbase|okx|bybit|etf|fomc|fed|sec|cpi|pce|tariff|yield|treasury|bond|stock|nasdaq|s&p|dow|ipo|earnings|revenue|profit|guidance|chips?|semiconductor|nvidia|tesla|meta|apple|google|microsoft|openai|deepseek|字节|阿里|英伟达|特斯拉|美联储|降息|加息|通胀|收益率|美债|关税|制裁|监管|证监会|交易所|上新|暴跌|暴涨|爆仓|链上|巨鲸|钱包|代币|加密|比特币|以太坊|山寨|芯片|财报|营收|利润|上市|美股|港股|A股|纳指|标普|道指|股票)/i;
const TWITTER_HARD_NOISE_RE = /(世界杯|football|soccer|the beautiful game|leaderboard|bitcoin rewards|outcomes campaign|足球|进球|比利时|信用卡|申卡|返现|hsbc|pulse卡|账号池|七折|relayrouter|vpn|机场|推广|广告|品牌套件|高考分数线|小语种|设备锁定|切换账号|account banned|quota|gopty|tmux|\bfable\b|mythos|竞猜活动|免费试用|free trial|trading signals?|交易信号)/i;
const TWITTER_NOISE_RE = /(活动|抽奖|促销|教程|攻略|开户|办卡)/i;
const TWITTER_NOISE_WITH_MARKET_RE = /(证监会|股票|市场|交易|美股|港股|A股|财报|营收|利润|监管|sec|stock|earnings|revenue|crypto|bitcoin|ethereum|币|链上|交易所)/i;

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
    "方程式快讯": "方程式新闻 BWEnews",
    "传统金融/宏观": "@BWETradFi |方程式财经（传统金融新闻）",
    "meme 链上监控": "meme链上监控"
  }) ?? {}) as Record<string, string>;
  const msgLimit = Number(dotGet(config, "data_sources.telegram.messages_per_channel", 15)) || 15;
  const fallbackHours = Number(dotGet(config, "briefing.telegram_fallback_hours", 168)) || 168;
  const lines = [`📰 Telegram 频道摘要（最近 ${hours}h）\n`];
  const channelRows = parseTelegramChannels(channels);
  const fetched = await Promise.all(
    channelRows.map(async ({ label, chat }) => {
      const result = await fetchTgChannelMessages(chat, hours, msgLimit, fallbackHours);
      return { label, ...result };
    })
  );

  const blocks: Array<{ label: string; text: string }> = [];
  for (const { label, messages, rawBytes, usedHours, stale, error } of fetched) {
    if (error) {
      lines.push(`【${label}】采集失败: ${error}`);
      continue;
    }
    if (!messages.length) {
      lines.push(`【${label}】暂无消息（tg 返回 ${rawBytes} 字节，最近 ${hours}h 与 ${fallbackHours}h 均无内容）`);
      continue;
    }
    const body = preprocessTelegramBody(messages.join("\n"));
    const staleNote = stale
      ? `（最近 ${hours}h 无新消息${usedHours ? `，展示最近 ${usedHours}h 内消息` : "，展示最近缓存消息"}）\n`
      : "";
    blocks.push({ label, text: body });
    if (!useLlm) lines.push(`【${label}】${staleNote}${body.slice(0, 1500)}`);
  }

  if (useLlm && blocks.length) {
    const summaries = await batchSummarize(blocks);
    blocks.forEach((b, i) => {
      const fetchedRow = fetched.find((row) => row.label === b.label);
      const staleNote = fetchedRow?.stale
        ? `（最近 ${hours}h 无新消息${fetchedRow.usedHours ? `，展示最近 ${fetchedRow.usedHours}h 内消息` : "，展示最近缓存消息"}）\n`
        : "";
      lines.push(`【${b.label}】${staleNote}${summaries[i]}`);
    });
  }
  return lines.join("\n\n");
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

export async function runMorningBrief(options: {
  sections?: BriefSection[];
  hours?: number;
  pushTg?: boolean;
  dryRun?: boolean;
} = {}): Promise<string> {
  const config = await loadTradeConfig();
  const defaultSections: BriefSection[] = ["stocks", "telegram", "twitter"];
  const enabled = (dotGet(config, "briefing.enabled", defaultSections) as string[] | undefined) ?? defaultSections;
  const sections = options.sections?.length
    ? options.sections.filter(isBriefSection)
    : enabled.filter(isBriefSection);
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

  const output = parts.join("\n");
  process.stdout.write(`${output}\n`);

  await getScratchpad().write("last_brief", { at: new Date().toISOString(), sections }, { source: "morning_brief", ttlHours: 24 });

  const pushTg = resolveBriefingPushTg(config, options);
  if (pushTg && !options.dryRun) {
    const chunks = chunkTelegramMessage(output).length;
    const ok = await sendTelegram(output, config);
    const status = ok ? "ok" : "failed";
    process.stderr.write(`[morning-brief] telegram push ${status} chunks=${chunks}\n`);
    await getScratchpad().write(
      "last_brief_push",
      { at: new Date().toISOString(), ok, sections, chunks },
      { source: "morning_brief", ttlHours: 24 }
    );
  }

  return output;
}
