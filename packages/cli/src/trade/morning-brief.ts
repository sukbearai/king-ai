import { dotGet, loadTradeConfig } from "./config.js";
import { okxGet, runOnchainos, runTg, surfFundingRate, surfMarketTicker } from "./data-helpers.js";
import { batchSummarize } from "./llm-summarize.js";
import { getScratchpad } from "./scratchpad.js";
import { sendTelegram } from "./telegram.js";
import { formatDisplayTime } from "./time-utils.js";
import { fetchStocksSection } from "./morning-brief-stocks.js";
import {
  defaultTwitterCachePath,
  engagementScore,
  entryTimestamp,
  formatTweetLine,
  iterCacheRecords
} from "./twitter-cache.js";
import { llmSummarize } from "./llm-summarize.js";

export type BriefSection = "market" | "stocks" | "twitter" | "telegram" | "leaderboard" | "pumpfun";

const SECTION_FETCHERS: Record<BriefSection, (hours: number) => Promise<string>> = {
  market: fetchMarketOverview,
  stocks: async () => fetchStocksSection(),
  telegram: fetchTelegramSummary,
  twitter: fetchTwitterSummary,
  leaderboard: fetchLeaderboard,
  pumpfun: fetchPumpfun
};

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

function extractTgMessages(raw: string): string[] {
  const prefixes = ["schema_version:", "platform:", "chat_id:", "content:", "text:", "- content:", "- text:"];
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("---")) continue;
    if (prefixes.some((p) => s.toLowerCase().startsWith(p) && !s.includes(":"))) continue;
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

async function fetchTwitterSummary(hours: number): Promise<string> {
  const config = await loadTradeConfig();
  const ds = (dotGet(config, "data_sources.twitter", {}) ?? {}) as Record<string, unknown>;
  const cachePath = String(ds.cache_path ?? defaultTwitterCachePath());
  const authorBlocklist = new Set(
    ((ds.author_blocklist as string[] | undefined) ?? []).map((s) => s.toLowerCase().replace(/^@/, ""))
  );
  const maxDisplay = Number(ds.max_display) || 500;
  const perAuthorCap = Number(ds.per_author_cap) || 2;
  const useLlm = dotGet(config, "briefing.llm_summarize", true) !== false;
  const cutoff = Date.now() - hours * 3600 * 1000;
  const lines: string[] = [`🐦 Twitter 时间线（最近 ${hours}h）\n`];
  const tweets: string[] = [];

  for await (const entry of iterCacheRecords(cachePath)) {
    const author = String(entry.author ?? "").toLowerCase();
    if (author && authorBlocklist.has(author)) continue;
    const ts = entryTimestamp(entry);
    if (!ts || ts.getTime() < cutoff) continue;
    const formatted = formatTweetLine(entry);
    if (formatted) tweets.push(formatted);
  }

  if (!tweets.length) {
    lines.push("暂无推文（需运行 twitter-collector 或检查 Chrome CDP 登录状态）");
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
    const summary = await llmSummarize(picked.join("\n"), "Twitter 时间线");
    lines.push(summary);
  } else {
    lines.push(...picked.slice(0, 30));
  }
  return lines.join("\n");
}

async function fetchTelegramSummary(hours: number): Promise<string> {
  const config = await loadTradeConfig();
  const useLlm = dotGet(config, "briefing.llm_summarize", true) !== false;
  const channels = (dotGet(config, "telegram.channels", {
    BWEnews: "方程式快讯",
    BWETradFi: "传统金融/宏观",
    meme: "meme 链上监控"
  }) ?? {}) as Record<string, string>;
  const msgLimit = Number(dotGet(config, "data_sources.telegram.messages_per_channel", 15)) || 15;
  const lines = [`📰 Telegram 频道摘要（最近 ${hours}h）\n`];
  const blocks: Array<{ label: string; text: string }> = [];

  for (const [channel, label] of Object.entries(channels)) {
    const raw = await runTg(["recent", channel, "--limit", String(msgLimit)]);
    const messages = extractTgMessages(raw);
    if (!messages.length) {
      lines.push(`【${label}】暂无消息`);
      continue;
    }
    const body = messages.join("\n");
    blocks.push({ label, text: body });
    if (!useLlm) lines.push(`【${label}】\n${body.slice(0, 1500)}`);
  }

  if (useLlm && blocks.length) {
    const summaries = await batchSummarize(blocks);
    blocks.forEach((b, i) => {
      lines.push(`【${b.label}】\n${summaries[i]}`);
    });
  }
  return lines.join("\n\n");
}

async function fetchLeaderboard(): Promise<string> {
  const config = await loadTradeConfig();
  const ds = (dotGet(config, "data_sources.leaderboard", {}) ?? {}) as Record<string, unknown>;
  const chains = (ds.chains as string[] | undefined) ?? ["solana"];
  const limit = Number(ds.limit) || 5;
  const lines = ["🏆 聪明钱 Leaderboard\n"];
  for (const chain of chains) {
    const data = await runOnchainos(["leaderboard", "list", "--chain", chain, "--limit", String(limit)]);
    lines.push(`${chain}: ${JSON.stringify(data).slice(0, 1500)}`);
  }
  return lines.join("\n");
}

async function fetchPumpfun(): Promise<string> {
  const config = await loadTradeConfig();
  const ds = (dotGet(config, "data_sources.pumpfun", {}) ?? {}) as Record<string, unknown>;
  const chain = String(ds.chain ?? "solana");
  const limit = Number(ds.limit) || 5;
  const data = await runOnchainos(["memepump", "tokens", "--chain", chain, "--limit", String(limit)]);
  return `🎰 Pump.fun 热榜\n\n${JSON.stringify(data, null, 2).slice(0, 3000)}`;
}

export async function runMorningBrief(options: {
  sections?: BriefSection[];
  hours?: number;
  pushTg?: boolean;
  dryRun?: boolean;
} = {}): Promise<string> {
  const config = await loadTradeConfig();
  const enabled = (dotGet(config, "briefing.enabled", [
    "market", "stocks", "telegram", "twitter", "leaderboard", "pumpfun"
  ]) as BriefSection[] | undefined) ?? ["market", "stocks", "telegram", "leaderboard", "pumpfun"];
  const sections = options.sections?.length ? options.sections : enabled.filter((s): s is BriefSection => s in SECTION_FETCHERS);
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

  if (options.pushTg && !options.dryRun) {
    await sendTelegram(output, config);
  }

  return output;
}