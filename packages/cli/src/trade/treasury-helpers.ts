import { yahooFinanceQuote } from "./data-helpers.js";

export interface TreasuryPriceQuote {
  symbol: string;
  price: number;
  change_pct: number;
}

export interface TreasuryYieldQuote {
  symbol: string;
  yield_pct: number;
  change_bps: number;
  prev_yield_pct: number;
}

export interface TreasuryYieldHighContext {
  symbol: string;
  lookback_years: number;
  period_high_pct: number;
  bps_below_high: number;
  is_new_high: boolean;
  is_near_high: boolean;
}

export interface TreasuryConfig {
  price_watchlist: Record<string, string>;
  yield_watchlist: Record<string, string>;
  price_drop_warning_pct: number;
  price_drop_critical_pct: number;
  yield_rise_warning_bps: number;
  yield_rise_critical_bps: number;
  yield_high_lookback_years: number;
  yield_near_high_bps: number;
}

export const DEFAULT_TREASURY_CONFIG: TreasuryConfig = {
  price_watchlist: { TLT: "20+年美债ETF" },
  yield_watchlist: { "^TYX": "30年期收益率", "^TNX": "10年期收益率" },
  price_drop_warning_pct: 1,
  price_drop_critical_pct: 2,
  yield_rise_warning_bps: 5,
  yield_rise_critical_bps: 10,
  yield_high_lookback_years: 5,
  yield_near_high_bps: 5,
};

export function parseTreasuryConfig(raw: unknown): TreasuryConfig {
  const ds = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    price_watchlist: recordOrDefault(ds.price_watchlist, DEFAULT_TREASURY_CONFIG.price_watchlist),
    yield_watchlist: recordOrDefault(ds.yield_watchlist, DEFAULT_TREASURY_CONFIG.yield_watchlist),
    price_drop_warning_pct: positiveOrDefault(
      ds.price_drop_warning_pct,
      DEFAULT_TREASURY_CONFIG.price_drop_warning_pct,
    ),
    price_drop_critical_pct: positiveOrDefault(
      ds.price_drop_critical_pct,
      DEFAULT_TREASURY_CONFIG.price_drop_critical_pct,
    ),
    yield_rise_warning_bps: positiveOrDefault(
      ds.yield_rise_warning_bps,
      DEFAULT_TREASURY_CONFIG.yield_rise_warning_bps,
    ),
    yield_rise_critical_bps: positiveOrDefault(
      ds.yield_rise_critical_bps,
      DEFAULT_TREASURY_CONFIG.yield_rise_critical_bps,
    ),
    yield_high_lookback_years: positiveOrDefault(
      ds.yield_high_lookback_years,
      DEFAULT_TREASURY_CONFIG.yield_high_lookback_years,
    ),
    yield_near_high_bps: positiveOrDefault(ds.yield_near_high_bps, DEFAULT_TREASURY_CONFIG.yield_near_high_bps),
  };
}

export function yieldChangeBps(currentPct: number, prevPct: number): number {
  if (!Number.isFinite(currentPct) || !Number.isFinite(prevPct)) return 0;
  return (currentPct - prevPct) * 100;
}

export function classifyPriceDropSeverity(
  changePct: number,
  cfg: Pick<TreasuryConfig, "price_drop_warning_pct" | "price_drop_critical_pct">,
): "none" | "warning" | "critical" {
  if (!Number.isFinite(changePct) || changePct > -cfg.price_drop_warning_pct) return "none";
  if (changePct <= -cfg.price_drop_critical_pct) return "critical";
  return "warning";
}

export function classifyYieldRiseSeverity(
  changeBps: number,
  cfg: Pick<TreasuryConfig, "yield_rise_warning_bps" | "yield_rise_critical_bps">,
): "none" | "warning" | "critical" {
  if (!Number.isFinite(changeBps) || changeBps < cfg.yield_rise_warning_bps) return "none";
  if (changeBps >= cfg.yield_rise_critical_bps) return "critical";
  return "warning";
}

export function buildYieldHighContext(
  symbol: string,
  currentYieldPct: number,
  periodHighPct: number,
  lookbackYears: number,
  nearHighBps: number,
): TreasuryYieldHighContext {
  const bpsBelowHigh = yieldChangeBps(currentYieldPct, periodHighPct);
  const isNewHigh = bpsBelowHigh >= 0.5;
  const isNearHigh = !isNewHigh && bpsBelowHigh >= -nearHighBps;
  return {
    symbol,
    lookback_years: lookbackYears,
    period_high_pct: periodHighPct,
    bps_below_high: bpsBelowHigh,
    is_new_high: isNewHigh,
    is_near_high: isNearHigh,
  };
}

export async function fetchTreasuryPriceQuote(symbol: string): Promise<TreasuryPriceQuote | null> {
  const q = await yahooFinanceQuote(symbol);
  if (!(q.price > 0) || q.change_pct == null || !Number.isFinite(q.change_pct)) return null;
  return { symbol, price: q.price, change_pct: q.change_pct };
}

export async function fetchTreasuryYieldQuote(symbol: string): Promise<TreasuryYieldQuote | null> {
  const q = await yahooFinanceQuote(symbol);
  if (!(q.price > 0) || q.change_pct == null || !Number.isFinite(q.change_pct)) return null;
  const prev = q.price / (1 + q.change_pct / 100);
  return {
    symbol,
    yield_pct: q.price,
    change_bps: yieldChangeBps(q.price, prev),
    prev_yield_pct: prev,
  };
}

export async function fetchYieldPeriodHigh(symbol: string, years: number): Promise<number | null> {
  const range = years >= 10 ? "10y" : "5y";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 king-ai/1.0" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      chart?: {
        result?: Array<{
          meta?: { regularMarketPrice?: number };
          indicators?: { quote?: Array<{ close?: Array<number | null> }> };
        }>;
      };
    };
    const result = body.chart?.result?.[0];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    const values = closes.filter((v): v is number => v != null && Number.isFinite(v));
    const current = result?.meta?.regularMarketPrice;
    if (typeof current === "number" && Number.isFinite(current)) values.push(current);
    if (!values.length) return null;
    return Math.max(...values);
  } catch {
    return null;
  }
}

export function formatYieldPct(value: number): string {
  return `${value.toFixed(3)}%`;
}

export function formatTreasuryBriefLine(
  label: string,
  symbol: string,
  priceQuote: TreasuryPriceQuote | null,
  yieldQuote: TreasuryYieldQuote | null,
  highCtx: TreasuryYieldHighContext | null,
  cfg: TreasuryConfig,
): string {
  if (priceQuote) {
    const flag = classifyPriceDropSeverity(priceQuote.change_pct, cfg) !== "none" ? " ⚠️" : "";
    const chg = `${priceQuote.change_pct >= 0 ? "+" : ""}${priceQuote.change_pct.toFixed(2)}%`;
    return `  ${label}(${symbol}): $${priceQuote.price.toFixed(2)} (${chg})${flag}`;
  }
  if (yieldQuote) {
    const rise = classifyYieldRiseSeverity(yieldQuote.change_bps, cfg);
    const highFlag = highCtx && (highCtx.is_new_high || highCtx.is_near_high) ? " 🔺" : "";
    const riseFlag = rise !== "none" ? " ⚠️" : "";
    const chg = `${yieldQuote.change_bps >= 0 ? "+" : ""}${yieldQuote.change_bps.toFixed(1)}bp`;
    let extra = "";
    if (highCtx && (highCtx.is_new_high || highCtx.is_near_high)) {
      extra = highCtx.is_new_high
        ? `，刷新${highCtx.lookback_years}年新高`
        : `，距${highCtx.lookback_years}年高点 ${Math.abs(highCtx.bps_below_high).toFixed(1)}bp`;
    }
    return `  ${label}(${symbol}): ${formatYieldPct(yieldQuote.yield_pct)} (${chg})${riseFlag}${highFlag}${extra}`;
  }
  return `  ${label}(${symbol}): N/A`;
}

function recordOrDefault(value: unknown, fallback: Record<string, string>): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...fallback };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (String(v).trim()) out[k] = String(v);
  }
  return Object.keys(out).length ? out : { ...fallback };
}

function positiveOrDefault(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
