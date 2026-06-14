import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { dotGet, loadTradeConfig } from "../config.js";
import { nowDisplay, runOpencli, stockQuote, yahooFinanceQuote } from "../data-helpers.js";

const DEFAULT_WATCHLIST: Record<string, string> = {
  CRCL: "Circle",
  PDD: "拼多多",
  GLD: "黄金ETF",
  "01810": "小米",
  SH000001: "上证指数",
  SZ399001: "深证成指",
  RKLB: "Rocket Lab",
  PLTR: "Palantir",
  SMCI: "Super Micro",
  TSLA: "特斯拉",
  NVDA: "英伟达",
  AAPL: "苹果"
};

const ETF_SYMBOLS = new Set(["GLD", "SH000001", "SZ399001"]);
const EXTENDED_THRESHOLD = 5;

interface StockQuoteResult {
  price: number;
  change_pct: number;
  extended_price: number | null;
  extended_change_pct: number;
  session: "regular" | "pre" | "post";
}

function isAshareSymbol(symbol: string): boolean {
  return symbol.length >= 8 && (symbol.startsWith("SH") || symbol.startsWith("SZ"));
}

function yahooSymbol(symbol: string): string {
  if (/^\d+$/.test(symbol) && symbol.length >= 4) {
    return `${Number.parseInt(symbol, 10)}.HK`;
  }
  if (symbol.toUpperCase() === "VIX") return "^VIX";
  if (isAshareSymbol(symbol)) {
    const code = symbol.slice(2);
    return symbol.startsWith("SH") ? `${code}.SS` : `${code}.SZ`;
  }
  return symbol;
}

async function ashareQuote(symbol: string): Promise<{ price: number; change_pct: number } | null> {
  const result = await runOpencli([
    "xueqiu", "stock", symbol,
    "--window", "foreground",
    "--site-session", "persistent",
    "--keep-tab", "true",
    "--format", "json"
  ], 5_000);
  if (result.ok && result.data.length) {
    const row = result.data[0] as Record<string, unknown>;
    const price = Number(row.price ?? row.Price);
    const changeRaw = row.change_pct ?? row.ChangePercent ?? row.changePercent ?? row.changePct ?? "0";
    const changePct = Number(String(changeRaw).replace(/%/g, "").replace(/\+/g, "").trim());
    if (Number.isFinite(price) && price > 0) {
      return { price, change_pct: Number.isFinite(changePct) ? changePct : 0 };
    }
  }

  const yf = await yahooFinanceQuote(yahooSymbol(symbol));
  if (yf.price > 0) return { price: yf.price, change_pct: yf.change_pct ?? 0 };
  return null;
}

async function yahooFinanceQuoteExtended(symbol: string): Promise<StockQuoteResult | null> {
  const base = await yahooFinanceQuote(yahooSymbol(symbol));
  if (base.price <= 0) return null;

  const yfSym = yahooSymbol(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=5m&range=2d&includePrePost=true`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 king-ai/1.0" },
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) {
      return {
        price: base.price,
        change_pct: base.change_pct ?? 0,
        extended_price: null,
        extended_change_pct: 0,
        session: "regular"
      };
    }

    const body = (await res.json()) as {
      chart?: {
        result?: Array<{
          meta?: {
            regularMarketPrice?: number;
            regularMarketTime?: number;
            currentTradingPeriod?: { regular?: { start?: number } };
          };
          timestamp?: number[];
          indicators?: { quote?: Array<{ close?: Array<number | null> }> };
        }>;
      };
    };

    const result = body.chart?.result?.[0];
    if (!result) {
      return {
        price: base.price,
        change_pct: base.change_pct ?? 0,
        extended_price: null,
        extended_change_pct: 0,
        session: "regular"
      };
    }

    const meta = result.meta ?? {};
    const regular = meta.regularMarketPrice ?? base.price;
    const regularTime = meta.regularMarketTime;
    const ts = result.timestamp ?? [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];

    let lastT: number | null = null;
    let lastC: number | null = null;
    for (let i = ts.length - 1; i >= 0; i--) {
      const c = closes[i];
      if (c != null) {
        lastT = ts[i]!;
        lastC = c;
        break;
      }
    }

    let extendedPrice: number | null = null;
    let extendedPct = 0;
    let session: "regular" | "pre" | "post" = "regular";

    if (lastT != null && lastC != null && regular && regularTime && Math.abs(lastC - regular) > 0.01) {
      if (lastT > regularTime) {
        const regStart = meta.currentTradingPeriod?.regular?.start;
        session = regStart && lastT < regStart ? "pre" : "post";
        extendedPrice = Math.round(lastC * 100) / 100;
        extendedPct = ((lastC - regular) / regular) * 100;
      }
    }

    return {
      price: base.price,
      change_pct: base.change_pct ?? 0,
      extended_price: extendedPrice,
      extended_change_pct: Math.round(extendedPct * 100) / 100,
      session
    };
  } catch {
    return {
      price: base.price,
      change_pct: base.change_pct ?? 0,
      extended_price: null,
      extended_change_pct: 0,
      session: "regular"
    };
  }
}

async function fetchStock(symbol: string): Promise<StockQuoteResult | null> {
  if (isAshareSymbol(symbol)) {
    const result = await ashareQuote(symbol);
    if (!result) return null;
    return {
      price: result.price,
      change_pct: result.change_pct,
      extended_price: null,
      extended_change_pct: 0,
      session: "regular"
    };
  }

  const ext = await yahooFinanceQuoteExtended(symbol);
  if (ext) return ext;

  const base = await stockQuote(symbol);
  if (base.price > 0) {
    return {
      price: base.price,
      change_pct: base.change_pct ?? 0,
      extended_price: null,
      extended_change_pct: 0,
      session: "regular"
    };
  }
  return null;
}

export function createRuleF(threshold = 5): AlertRule {
  const lastPushedPrice: Record<string, string> = {};
  const lastPushedExtended: Record<string, string> = {};
  let watchlist: Record<string, string> = { ...DEFAULT_WATCHLIST };

  return {
    name: "stock_moves",
    ruleKey: "f",
    defaultCooldown: 3600,
    async check(state: AlertState): Promise<Alert[]> {
      const alerts: Alert[] = [];
      const config = await loadTradeConfig();
      const cfgWl = dotGet(config, "stocks.watchlist", null);
      if (cfgWl && typeof cfgWl === "object" && Object.keys(cfgWl as object).length) {
        watchlist = cfgWl as Record<string, string>;
      }

      for (const [symbol, name] of Object.entries(watchlist)) {
        const quote = await fetchStock(symbol);
        if (!quote) continue;

        const { price, change_pct: change, extended_price: extPrice, extended_change_pct: extChange, session } = quote;
        const symThreshold = ETF_SYMBOLS.has(symbol) ? 3 : threshold;

        if (Math.abs(change) >= symThreshold) {
          const priceStr = String(price);
          if (priceStr !== lastPushedPrice[symbol]) {
            const sevBand = Math.abs(change) >= 8 ? "critical" : "warning";
            const alertKey = `stock_${symbol}_${sevBand}`;
            if (state.canAlert(alertKey, 7200)) {
              lastPushedPrice[symbol] = priceStr;
              const currency = isAshareSymbol(symbol) ? "¥" : "$";
              const direction = change > 0 ? "暴涨" : "暴跌";
              alerts.push(createAlert({
                rule: "股票异动",
                severity: Math.abs(change) >= 8 ? "critical" : "info",
                title: `${name} (${symbol}) ${direction} ${change >= 0 ? "+" : ""}${change.toFixed(1)}%`,
                detail: `当前价格: ${currency}${priceStr}`,
                timestamp: nowDisplay(),
                direction: change > 0 ? 1 : -1,
                strength: Math.min(Math.abs(change) / 10, 1),
                asset: symbol
              }));
            }
          }
        }

        if (extPrice != null && Math.abs(extChange) >= EXTENDED_THRESHOLD) {
          const extStr = `${extPrice}_${session}`;
          if (extStr !== lastPushedExtended[symbol]) {
            const sevBand = Math.abs(extChange) >= 8 ? "warning" : "info";
            const alertKey = `stock_${symbol}_ext_${sevBand}`;
            if (state.canAlert(alertKey, 7200)) {
              lastPushedExtended[symbol] = extStr;
              const sessionLabel = session === "post" ? "盘后" : "盘前";
              const direction = extChange > 0 ? "暴涨" : "暴跌";
              alerts.push(createAlert({
                rule: "股票异动",
                severity: Math.abs(extChange) >= 8 ? "warning" : "info",
                title: `${name} (${symbol}) ${sessionLabel}${direction} ${extChange >= 0 ? "+" : ""}${extChange.toFixed(1)}%`,
                detail: `${sessionLabel}价: $${extPrice} (收盘 $${price}, 日内 ${change >= 0 ? "+" : ""}${change.toFixed(1)}%)`,
                timestamp: nowDisplay(),
                direction: extChange > 0 ? 1 : -1,
                strength: Math.min(Math.abs(extChange) / 10, 1),
                asset: symbol
              }));
            }
          }
        }
      }

      return alerts;
    }
  };
}
