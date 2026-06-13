import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { dotGet, loadTradeConfig } from "../config.js";
import {
  fetchPolymarket7dTrades,
  fetchPolymarketActivity,
  fetchPolymarketPositions,
  nowDisplay,
  polyhubGet
} from "../data-helpers.js";
import { TRADE_STATE_DIR } from "../../paths.js";

const TAGS = ["Crypto", "Politics", "Sports", "Economy", "AI", "Weather"];
const TAG_CN: Record<string, string> = {
  Crypto: "加密", Politics: "政治", Sports: "体育", Economy: "经济",
  AI: "AI", Weather: "天气", Other: "其他", ShortTerm: "短期", Entertainment: "娱乐"
};
const TAG_SEASONALITY: Record<string, string> = {
  Crypto: "year_round", Politics: "event_window", Sports: "year_round",
  Economy: "event_window", AI: "niche", Weather: "niche"
};
const TAG_ICON: Record<string, string> = {
  Sports: "🏈", Crypto: "₿", AI: "🤖", Weather: "🌤",
  Politics: "🏛", Economy: "📊", Other: "📌", ShortTerm: "⏱️", Entertainment: "🎬"
};

const MIN_TRADES = 20;
const EV_BOUGHT_WARNING = 0.05;
const EV_BOUGHT_CRITICAL = 0.15;
const EXTREME_ROI_MIN = 20;
const EXTREME_PNL_MIN = 200_000;
const TAG_ROI_COOLDOWN = 7200;
const PNL_VELOCITY_THRESHOLD = 0.5;
const PNL_VELOCITY_MIN = 50_000;
const AVGADT_BOT_THRESHOLD = 100;

const TAG_KEYWORDS: Record<string, string[]> = {
  Sports: ["vs.", "O/U", "NFL", "NBA", "UFC", "MLB", "World Cup"],
  Crypto: ["Bitcoin", "BTC", "ETH", "Ethereum", "Solana", "crypto", "DeFi"],
  AI: ["AI ", " GPT", "OpenAI", "Anthropic", "LLM", "AGI"],
  Weather: ["temperature", "hurricane", "weather", "climate"],
  Politics: ["Trump", "Biden", "election", "president", "Congress", "vote"],
  Economy: ["Fed ", "rate cut", "inflation", "CPI", "GDP", "recession", "oil price"]
};
const SHORT_TERM_KW = ["Up or Down", "Higher or Lower", "Up/Down"];
const ENTERTAINMENT_KW = ["Box Office", "Grammy", "Oscar", "Emmy"];

const PNL_SNAPSHOT_PATH = join(TRADE_STATE_DIR, "polymarket_pnl_snapshots.json");

function fmtPnl(pnl: number): string {
  const abs = Math.abs(pnl);
  if (abs < 1000) return `$${abs.toFixed(0)}`;
  if (abs < 1_000_000) return `$${(abs / 1000).toFixed(0)}K`;
  return `$${(abs / 1_000_000).toFixed(1)}M`;
}

function classifyPosition(title: string): string {
  const lower = title.toLowerCase();
  if (SHORT_TERM_KW.some((kw) => lower.includes(kw.toLowerCase()))) return "ShortTerm";
  if (ENTERTAINMENT_KW.some((kw) => lower.includes(kw.toLowerCase()))) return "Entertainment";
  for (const [tag, keywords] of Object.entries(TAG_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw.toLowerCase()))) return tag;
  }
  return "Other";
}

function convictionScore(
  position: Record<string, unknown>,
  allPositions: Array<Record<string, unknown>>,
  recentTrades?: Array<Record<string, unknown>>
): number {
  let score = 0;
  const current = Number(position.currentValue ?? 0);
  const title = String(position.title ?? "");
  const total = allPositions.reduce((s, p) => s + (Number(p.currentValue ?? 0) > 0 ? Number(p.currentValue ?? 0) : 0), 0);
  if (total > 0) score += Math.min((current / total) * 2, 0.4);
  if (recentTrades) {
    const sameMarketBuys = recentTrades.filter(
      (t) => String(t.title ?? "") === title && String(t.side ?? "").toUpperCase() === "BUY"
    ).length;
    if (sameMarketBuys >= 3) score += 0.3;
    else if (sameMarketBuys >= 2) score += 0.2;
    else if (sameMarketBuys >= 1) score += 0.1;
  }
  const active = allPositions.filter((p) => Number(p.currentValue ?? 0) > 0);
  const avgValue = total / (active.length || 1);
  if (avgValue > 0 && current > avgValue) score += Math.min(((current / avgValue) - 1) * 0.3, 0.3);
  return Math.min(score, 1);
}

function formatTopPositions(
  positions: Array<Record<string, unknown>>,
  limit = 3,
  recentTrades?: Array<Record<string, unknown>>,
  convictionThreshold = 0.2
): string {
  if (!positions.length) return "";
  const nowStr = new Date().toISOString().slice(0, 10);
  const copyable: Array<[number, string]> = [];
  const lowConviction: string[] = [];
  const filteredOut: Array<[string, string]> = [];

  for (const p of positions) {
    const title = String(p.title ?? "");
    const outcome = String(p.outcome ?? "?");
    const current = Number(p.currentValue ?? 0);
    const size = Number(p.size ?? 0);
    const pnl = Number(p.cashPnl ?? 0);
    const end = String(p.endDate ?? "").slice(0, 10);
    if (current <= 0) continue;
    const price = size > 0 ? current / size : 0;
    const category = classifyPosition(title);
    const icon = TAG_ICON[category] ?? "📌";
    const isExpired = Boolean(end && end < nowStr);
    const entryBase = `  ${icon} ${outcome} $${current.toLocaleString()} (PnL $${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}) | ${title.slice(0, 40)} [${end}]`;

    if (category === "Sports") filteredOut.push(["🏈不可跟", entryBase]);
    else if (category === "ShortTerm") filteredOut.push(["⏱️秒结算", entryBase]);
    else if (category === "Entertainment") filteredOut.push(["🎬无alpha", entryBase]);
    else if (isExpired) filteredOut.push(["⌛已过期", entryBase]);
    else if (price > 0.85 || price < 0.15) filteredOut.push(["🔒已定", entryBase]);
    else {
      const conv = convictionScore(p, positions, recentTrades);
      const catCn = TAG_CN[category] ?? category;
      const entry = `  ${icon}[${catCn}] ${outcome} $${current.toLocaleString()} @${price.toFixed(2)} [C=${conv.toFixed(1)}] (PnL $${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}) | ${title.slice(0, 40)} [${end}]`;
      if (conv >= convictionThreshold) copyable.push([conv, entry]);
      else lowConviction.push(entry);
    }
  }

  copyable.sort((a, b) => b[0] - a[0]);
  const lines: string[] = [];
  if (copyable.length) {
    lines.push(`\n✅ 可跟仓位 (确信度≥${convictionThreshold}, 价格0.15-0.85):`);
    lines.push(...copyable.slice(0, limit).map(([, e]) => e));
  } else if (lowConviction.length) {
    lines.push(`\n⚠️ 低确信度仓位 (C<${convictionThreshold}):`);
    lines.push(...lowConviction.slice(0, 2));
  } else if (filteredOut.length) {
    lines.push("\n🚫 不可跟仓位:");
    lines.push(...filteredOut.slice(0, 2).map(([reason, e]) => `  [${reason}]${e}`));
  }
  return lines.length ? lines.join("\n") : "";
}

function formatRecentTrades(trades: Array<Record<string, unknown>>, limit = 5): string {
  if (!trades.length) return "";
  const lines = trades.slice(0, limit).map((t) => {
    const ts = new Date(Number(t.timestamp ?? 0) * 1000).toISOString().slice(5, 16).replace("T", " ");
    const side = String(t.side ?? "?");
    const usdc = Number(t.usdcSize ?? 0);
    const price = Number(t.price ?? 0);
    const title = String(t.title ?? "").slice(0, 40);
    const outcome = String(t.outcome ?? "?");
    const emoji = side === "BUY" ? "🟢" : "🔴";
    return `  ${emoji} ${ts} ${side} $${usdc.toLocaleString()} @${price.toFixed(2)} | ${outcome} | ${title}`;
  });
  return "\n近期交易:\n" + lines.join("\n");
}

async function fetchPositionWinrate(addr: string): Promise<[number, number, number]> {
  const positions = await fetchPolymarketPositions(addr);
  if (!positions.length) return [0, 0, 0];
  const winners = positions.filter((p) => Number(p.cashPnl ?? 0) > 0).length;
  const losers = positions.filter((p) => Number(p.cashPnl ?? 0) < 0).length;
  const netPnl = positions.reduce((s, p) => s + Number(p.cashPnl ?? 0), 0);
  return [winners, losers, netPnl];
}

function tradeHistoryScore(trades: Array<Record<string, unknown>>): [number, string] {
  if (!trades.length) return [0, ""];
  let score = 0;
  const details: string[] = [];
  const marketStats = new Map<string, { buy: number; sell: number; vol: number }>();
  for (const t of trades) {
    const title = String(t.title ?? "");
    const side = String(t.side ?? "").toLowerCase();
    const usdc = Number(t.usdcSize ?? 0);
    if (!title || !side) continue;
    const s = marketStats.get(title) ?? { buy: 0, sell: 0, vol: 0 };
    if (side === "buy") s.buy++;
    else if (side === "sell") s.sell++;
    s.vol += usdc;
    marketStats.set(title, s);
  }
  if (marketStats.size) {
    const top = [...marketStats.entries()].sort((a, b) => b[1].vol - a[1].vol)[0]!;
    const totalTop = top[1].buy + top[1].sell;
    if (totalTop >= 3) {
      const buyRatio = top[1].buy / totalTop;
      if (buyRatio >= 0.7) {
        score += 5;
        details.push(`重仓看多${top[0].slice(0, 20)}(${top[1].buy}买)`);
      } else if (buyRatio <= 0.3) {
        score += 5;
        details.push(`重仓看空${top[0].slice(0, 20)}(${top[1].sell}卖)`);
      }
    }
  }
  const sizes = trades.map((t) => Number(t.usdcSize ?? 0)).filter((v) => v > 0);
  const totalVol = sizes.reduce((a, b) => a + b, 0);
  const avgSize = sizes.length ? totalVol / sizes.length : 0;
  if (avgSize >= 10_000) {
    score += 5;
    details.push(`大手笔(均$${avgSize.toLocaleString()})`);
  }
  if (totalVol < 10_000) {
    score -= 5;
    details.push(`低量(7d共$${totalVol.toLocaleString()})`);
  }
  if (trades.length >= 20) {
    score += 5;
    details.push(`7d活跃(${trades.length}笔)`);
  }
  return [score, details.join(" ")];
}

async function scoreTrader(t: Record<string, unknown>, addr = ""): Promise<[number, string, string]> {
  const roi30 = Number.parseFloat(String(t.roi_30 ?? t.roi ?? 0));
  const pnl30 = Number.parseFloat(String(t.pnl_30 ?? t.pnl ?? 0));
  const timing = Number.parseFloat(String(t.timingScore ?? 50));
  const ev = Number.parseFloat(String(t.evPerBought ?? 0));
  let score = 0;
  if (roi30 > 5) score += 15;
  else if (roi30 > 1) score += 8;
  if (pnl30 > 50_000) score += 15;
  else if (pnl30 > 10_000) score += 8;
  if (timing > 52) score += 15;
  else if (timing > 50.5) score += 8;
  if (ev > 0.05) score += 15;
  else if (ev > 0.02) score += 8;

  let winStr = "";
  if (addr) {
    const [winners, losers, netPnl] = await fetchPositionWinrate(addr);
    const totalPos = winners + losers;
    if (totalPos >= 5) {
      const winRate = (winners / totalPos) * 100;
      if (winRate >= 60 && winRate <= 90) score += 25;
      else if (winRate > 90 && totalPos < 30) score += 5;
      else if (winRate >= 50) score += 15;
      else if (winRate < 20 && totalPos >= 10) score -= 10;
      if (totalPos >= 10) score += 15;
      else if (totalPos >= 5) score += 8;
      winStr = ` 胜率=${winners}/${totalPos}(${winRate.toFixed(0)}%) 净PnL=$${netPnl.toLocaleString()}`;
    }
  }

  let tradeStr = "";
  if (addr) {
    const trades7d = await fetchPolymarket7dTrades(addr);
    if (trades7d.length) {
      const [tradeDelta, tradeDetail] = tradeHistoryScore(trades7d);
      score += tradeDelta;
      if (tradeDetail) tradeStr = ` | 交易: ${tradeDetail}`;
    }
  }

  const grade = score >= 80 ? "🏆" : score >= 60 ? "🥈" : score >= 40 ? "🥉" : "⚪";
  return [score, grade, `${grade} ${score}/100 (timing=${timing.toFixed(1)} EV=${(ev * 100).toFixed(1)}%${winStr}${tradeStr})`];
}

function isSuspicious(t: Record<string, unknown>): [boolean, string] {
  if (t.isBot) return [true, "标记为机器人"];
  const avgAdt = Number.parseFloat(String(t.avgAdt ?? 0));
  if (avgAdt > AVGADT_BOT_THRESHOLD) return [true, `交易频率异常(avgAdt=${avgAdt.toFixed(0)})`];
  return [false, ""];
}

interface PnlSnapshot {
  pnl: number;
  ts: number;
}

class PnlSnapshotStore {
  private data = new Map<string, PnlSnapshot>();

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(PNL_SNAPSHOT_PATH, "utf8")) as Record<string, PnlSnapshot>;
      this.data = new Map(Object.entries(raw));
    } catch {
      this.data = new Map();
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(PNL_SNAPSHOT_PATH), { recursive: true });
    const obj = Object.fromEntries(this.data);
    await writeFile(PNL_SNAPSHOT_PATH, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  }

  async getAndUpdate(addr: string, tag: string, currentPnl: number): Promise<[number | null, number]> {
    await this.load();
    const key = `${addr.slice(0, 16)}_${tag}`;
    const now = Date.now() / 1000;
    const prev = this.data.get(key);
    this.data.set(key, { pnl: currentPnl, ts: now });
    await this.save();
    if (!prev) return [null, 0];
    return [prev.pnl, (now - prev.ts) / 3600];
  }
}

class ProfileCache {
  private cache = new Map<string, [number, [string, string, number]]>();
  private ttl = 3600;

  findSpecialization(addr: string, positions: Array<Record<string, unknown>>): [string, string, number] {
    const now = Date.now() / 1000;
    const cached = this.cache.get(addr);
    if (cached && now - cached[0] < this.ttl) return cached[1];

    const tagPnl = new Map<string, number>();
    const tagValue = new Map<string, number>();
    for (const p of positions) {
      const current = Number(p.currentValue ?? 0);
      if (current <= 0) continue;
      const cat = classifyPosition(String(p.title ?? ""));
      if (cat === "ShortTerm" || cat === "Entertainment") continue;
      tagPnl.set(cat, (tagPnl.get(cat) ?? 0) + Number(p.cashPnl ?? 0));
      tagValue.set(cat, (tagValue.get(cat) ?? 0) + current);
    }
    if (!tagPnl.size) return ["", "", 0];

    const sorted = [...tagPnl.entries()].sort((a, b) => b[1] - a[1]);
    const [bestTag] = sorted[0]!;
    const totalValue = [...tagValue.values()].reduce((a, b) => a + b, 0);
    const concentration = totalValue > 0 ? (tagValue.get(bestTag) ?? 0) / totalValue : 0;
    const weakTags = [...tagPnl.entries()]
      .filter(([tag, pnl]) => pnl < 0 && tag !== bestTag)
      .map(([tag, pnl]) => `${TAG_CN[tag] ?? tag}($${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()})`);
    const weakness = weakTags.length ? `亏损: ${weakTags.slice(0, 3).join(", ")}` : "";
    const result: [string, string, number] = [bestTag, weakness, concentration];
    this.cache.set(addr, [now, result]);
    return result;
  }
}

async function fetchTag(tag: string, limit = 10): Promise<Array<Record<string, unknown>>> {
  const params = new URLSearchParams({
    tag,
    time_range: "30d",
    limit: String(limit),
    offset: "0",
    sort_by: "pnl",
    sort_direction: "desc",
    trade_count_30_min: String(MIN_TRADES)
  });
  const data = await polyhubGet(`/api/v1/traders-v2/?${params}`);
  return data as Array<Record<string, unknown>>;
}

export function createRuleD(): AlertRule {
  const knownTraders = new Map<string, Set<string>>();
  const pnlDb = new PnlSnapshotStore();
  const profileCache = new ProfileCache();

  return {
    name: "polymarket_shifts",
    ruleKey: "d",
    defaultCooldown: 7200,
    async check(state: AlertState): Promise<Alert[]> {
      delete state.cooldownConfig.d;
      const alerts: Alert[] = [];
      const config = await loadTradeConfig();
      const convictionThreshold = Number(dotGet(config, "alerts.polymarket.conviction_threshold", 0.2)) || 0.2;

      for (const tag of TAGS) {
        const tagCn = TAG_CN[tag] ?? tag;
        const data = await fetchTag(tag, 10);
        const cleanData: Array<Record<string, unknown>> = [];
        for (const t of data) {
          if (!t || typeof t !== "object") continue;
          const [suspicious] = isSuspicious(t);
          if (suspicious) continue;
          if (Number.parseInt(String(t.trade_count_7 ?? 0), 10) === 0) continue;
          cleanData.push(t);
        }

        // Leaderboard shifts
        const currentAddrs = new Set<string>();
        for (const t of cleanData.slice(0, 5)) {
          const addr = String(t.user ?? "");
          if (!addr) continue;
          currentAddrs.add(addr);
          const pnl = Number.parseFloat(String(t.pnl ?? 0));
          const roi = Number.parseFloat(String(t.roi ?? 0));
          const trades = Number.parseInt(String(t.tradeCount30 ?? t.trade_count_30 ?? 0), 10);

          if (Math.abs(roi) > EXTREME_ROI_MIN && trades >= MIN_TRADES && Math.abs(pnl) >= EXTREME_PNL_MIN) {
            const alertKey = `d_roi_${tag}_${addr.slice(0, 10)}`;
            const tagKey = `d_roi_tag_${tag}`;
            if (state.canAlert(alertKey, 86400) && state.canAlert(tagKey, TAG_ROI_COOLDOWN)) {
              const [score, grade, scoreDetail] = await scoreTrader(t, addr);
              const positions = await fetchPolymarketPositions(addr, 8000);
              const recentTrades = await fetchPolymarketActivity(addr, 50, 8000);
              const [specTag, weakness, concentration] = profileCache.findSpecialization(addr, positions);
              let specLine = "";
              if (specTag && concentration > 0.3) {
                specLine = `\n专精: ${TAG_ICON[specTag] ?? "📌"}${TAG_CN[specTag] ?? specTag}板块(${(concentration * 100).toFixed(0)}%仓位)`;
                if (weakness) specLine += ` | ${weakness}`;
              }
              const posLine = formatTopPositions(positions, 3, recentTrades, convictionThreshold);
              const tradesLine = formatRecentTrades(recentTrades);
              const hasCopyable = posLine.includes("✅ 可跟仓位");
              const sev: Alert["severity"] = score >= 60 && hasCopyable ? "warning" : "info";
              const action = hasCopyable
                ? `${grade}高评分+有高确信可跟仓位=建议跟单`
                : score >= 60 ? `${grade}高评分但持仓已定/低确信=仅观察` : "评分偏低，仅供参考";
              alerts.push(createAlert({
                rule: "Polymarket",
                severity: sev,
                title: `预测市场${tagCn}板块极端盈利账户`,
                detail: `发生了什么: ${tagCn}板块有人赚了${fmtPnl(pnl)}，回报率${(roi * 100).toFixed(0)}%，30天${trades}笔交易\n评分: ${scoreDetail}${specLine}${posLine}${tradesLine}\n地址: ${addr}\n查看: https://polyhub.hubble.xyz/trader/${addr}\n你该怎么做: ${action}`,
                timestamp: nowDisplay()
              }));
            }
          }
        }

        const prev = knownTraders.get(tag) ?? new Set<string>();
        if (prev.size) {
          for (const addr of currentAddrs) {
            if (prev.has(addr)) continue;
            const td = cleanData.find((t) => String(t.user ?? "") === addr) ?? {};
            const pnl = Number.parseFloat(String(td.pnl ?? 0));
            const trades = Number.parseInt(String(td.tradeCount30 ?? td.trade_count_30 ?? 0), 10);
            if (!state.canAlert(`d_new_${tag}_${addr.slice(0, 10)}`, 86400)) continue;
            const [score, grade, scoreDetail] = await scoreTrader(td, addr);
            const positions = score >= 40 ? await fetchPolymarketPositions(addr, 8000) : [];
            const recentTrades = score >= 40 ? await fetchPolymarketActivity(addr, 50, 8000) : [];
            const posLine = formatTopPositions(positions, 3, recentTrades, convictionThreshold);
            const tradesLine = formatRecentTrades(recentTrades);
            const hasCopyable = posLine.includes("✅ 可跟仓位");
            const sev: Alert["severity"] = Math.abs(pnl) >= 100_000 && score >= 40 && hasCopyable ? "warning" : "info";
            alerts.push(createAlert({
              rule: "Polymarket",
              severity: sev,
              title: `预测市场${tagCn}板块新大户上榜`,
              detail: `发生了什么: 新地址进入${tagCn}板块 Top5，盈利${fmtPnl(pnl)}，${trades}笔交易\n评分: ${scoreDetail}${posLine}${tradesLine}\n地址: ${addr}\n查看: https://polyhub.hubble.xyz/trader/${addr}`,
              timestamp: nowDisplay()
            }));
          }
        }
        knownTraders.set(tag, currentAddrs);

        // Smart money (EV/Bought)
        for (const t of cleanData) {
          const addr = String(t.user ?? "");
          if (!addr) continue;
          const evBought = Number.parseFloat(String(t.evPerBought ?? 0));
          const pnl = Number.parseFloat(String(t.pnl ?? 0));
          const trades = Number.parseInt(String(t.tradeCount30 ?? t.trade_count_30 ?? 0), 10);
          const volume = Number.parseFloat(String(t.volume ?? 0));
          if (trades < MIN_TRADES || pnl < 10_000 || evBought <= 0) continue;
          if (pnl > 100_000 && evBought < 0.02 && volume > 500_000) continue;
          if (evBought >= EV_BOUGHT_WARNING && state.canAlert(`d_ev_${tag}_${addr.slice(0, 10)}`, 86400 * 3)) {
            const [score, grade, scoreDetail] = await scoreTrader(t, addr);
            const positions = score >= 60 ? await fetchPolymarketPositions(addr, 8000) : [];
            const recentTrades = score >= 60 ? await fetchPolymarketActivity(addr, 50, 8000) : [];
            const [specTag, weakness, concentration] = profileCache.findSpecialization(addr, positions);
            let specLine = "";
            if (specTag) {
              const specCn = TAG_CN[specTag] ?? specTag;
              specLine = concentration > 0.7
                ? `\n专精: ${TAG_ICON[specTag] ?? "📌"}${specCn}(${(concentration * 100).toFixed(0)}%仓位)，高度垂直`
                : concentration > 0.3
                  ? `\n专精: ${TAG_ICON[specTag] ?? "📌"}${specCn}(${(concentration * 100).toFixed(0)}%仓位)，兼顾其他`
                  : "";
              if (weakness) specLine += ` | ${weakness}`;
              if (specTag !== tag && concentration > 0.6) specLine += `\n建议: 此人强项在${specCn}而非${tagCn}，跟单需谨慎`;
            }
            const seasonality = TAG_SEASONALITY[tag] ?? "year_round";
            let seasonLine = "";
            if (seasonality === "event_window") seasonLine = `\n⏰ ${tagCn}属于事件驱动赛道，信号仅在事件窗口期有效`;
            else if (seasonality === "niche") seasonLine = `\n💎 ${tagCn}属于小众赛道，延迟跟单仍有效`;
            const posLine = formatTopPositions(positions, 3, recentTrades, convictionThreshold);
            const tradesLine = formatRecentTrades(recentTrades);
            const hasCopyable = posLine.includes("✅ 可跟仓位");
            const quality = evBought >= EV_BOUGHT_CRITICAL ? "顶级" : "优质";
            const sev: Alert["severity"] = score >= 60 && hasCopyable ? "warning" : "info";
            alerts.push(createAlert({
              rule: "Polymarket",
              severity: sev,
              title: `预测市场${tagCn}板块发现${quality}聪明钱`,
              detail: `发生了什么: ${tagCn}板块有人每投$1赚$${(evBought * 100).toFixed(1)}分（EV/Bought=${(evBought * 100).toFixed(1)}%），盈利${fmtPnl(pnl)}，30天${trades}笔交易\n评分: ${scoreDetail}${specLine}${seasonLine}${posLine}${tradesLine}\n地址: ${addr}\n查看: https://polyhub.hubble.xyz/trader/${addr}`,
              timestamp: nowDisplay()
            }));
            void grade;
          }
        }

        // PnL velocity
        for (const t of cleanData) {
          const addr = String(t.user ?? "");
          if (!addr) continue;
          const pnl = Number.parseFloat(String(t.pnl ?? 0));
          const trades = Number.parseInt(String(t.tradeCount30 ?? t.trade_count_30 ?? 0), 10);
          if (pnl < PNL_VELOCITY_MIN || trades < MIN_TRADES) continue;
          const [prevPnl, hours] = await pnlDb.getAndUpdate(addr, tag, pnl);
          if (prevPnl == null || hours < 0.1) continue;
          if (prevPnl > 0) {
            const growth = (pnl - prevPnl) / prevPnl;
            if (growth >= PNL_VELOCITY_THRESHOLD && state.canAlert(`d_vel_${tag}_${addr.slice(0, 10)}`, 86400)) {
              const positions = await fetchPolymarketPositions(addr, 8000);
              const recentTrades = await fetchPolymarketActivity(addr, 50, 8000);
              const posLine = formatTopPositions(positions, 3, recentTrades, convictionThreshold);
              const hasCopyable = posLine.includes("✅ 可跟仓位");
              const sev: Alert["severity"] = hasCopyable ? "warning" : "info";
              const delta = pnl - prevPnl;
              alerts.push(createAlert({
                rule: "Polymarket",
                severity: sev,
                title: `预测市场${tagCn}板块PnL飙升`,
                detail: `发生了什么: ${tagCn}板块某地址在${hours.toFixed(0)}小时内盈利从${fmtPnl(prevPnl)}飙升到${fmtPnl(pnl)}（+${fmtPnl(delta)}，+${(growth * 100).toFixed(0)}%）${posLine}\n地址: ${addr}\n查看: https://polyhub.hubble.xyz/trader/${addr}`,
                timestamp: nowDisplay()
              }));
            }
          }
        }
      }
      return alerts;
    }
  };
}