import { dotGet, loadTradeConfig } from "./config.js";
import { stockQuote } from "./data-helpers.js";
import { formatDisplayShortTime } from "./time-utils.js";
import { parseTreasuryConfig } from "./treasury-helpers.js";

const DEFAULT_WATCHLIST: Record<string, string> = {
  CRCL: "Circle",
  PDD: "拼多多",
  GLD: "黄金ETF",
  "01810": "小米",
  RKLB: "Rocket Lab",
  TSLA: "特斯拉",
  NVDA: "英伟达",
};

const ETF_SYMBOLS = new Set(["GLD", "SH000001", "SZ399001"]);

export function formatStockPrice(symbol: string, price: number): string {
  if (/^(SH|SZ)\d+/i.test(symbol)) return price.toFixed(2);
  if (/^\d{5}$/.test(symbol)) return `HK$${price.toFixed(2)}`;
  return `$${price.toFixed(2)}`;
}

export function filterWatchlist(wl: Record<string, string>, exclude: Iterable<string>): Record<string, string> {
  const excluded = new Set(Array.from(exclude, (symbol) => symbol.toLowerCase()));
  return Object.fromEntries(Object.entries(wl).filter(([symbol]) => !excluded.has(symbol.toLowerCase())));
}

export async function fetchStocksSection(): Promise<string> {
  const config = await loadTradeConfig();
  const configuredWatchlist = (dotGet(config, "stocks.watchlist", DEFAULT_WATCHLIST) ?? DEFAULT_WATCHLIST) as Record<
    string,
    string
  >;
  const enabled = (dotGet(config, "briefing.enabled", []) as string[] | undefined) ?? [];
  const wl = enabled.includes("treasury")
    ? filterWatchlist(
        configuredWatchlist,
        Object.keys(parseTreasuryConfig(dotGet(config, "treasury", {})).price_watchlist),
      )
    : configuredWatchlist;
  const lines = ["📈 股票/ETF\n"];

  for (const [symbol, name] of Object.entries(wl)) {
    const q = await stockQuote(symbol);
    if (!q.price) {
      lines.push(`  ${name}(${symbol}): N/A`);
      continue;
    }
    const threshold = ETF_SYMBOLS.has(symbol) ? 3 : 5;
    const chg = q.change_pct;
    const asOf = q.market_time ? ` @${formatDisplayShortTime(new Date(q.market_time * 1000))}` : "";
    if (chg == null) {
      lines.push(`  ${name}(${symbol}): ${formatStockPrice(symbol, q.price)} (涨跌幅 N/A)${asOf}`);
      continue;
    }
    const flag = Math.abs(chg) >= threshold ? " ⚠️" : "";
    lines.push(
      `  ${name}(${symbol}): ${formatStockPrice(symbol, q.price)} (${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%)${flag}${asOf}`,
    );
  }
  return lines.join("\n");
}
