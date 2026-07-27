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

export interface StockQuoteRow {
  symbol: string;
  name: string;
  price: number | null;
  changePct: number | null;
  marketTime: number | null;
  threshold: number;
}

export function formatStockPrice(symbol: string, price: number): string {
  if (/^(SH|SZ)\d+/i.test(symbol)) return price.toFixed(2);
  if (/^\d{5}$/.test(symbol)) return `HK$${price.toFixed(2)}`;
  return `$${price.toFixed(2)}`;
}

export function filterWatchlist(wl: Record<string, string>, exclude: Iterable<string>): Record<string, string> {
  const excluded = new Set(Array.from(exclude, (symbol) => symbol.toLowerCase()));
  return Object.fromEntries(Object.entries(wl).filter(([symbol]) => !excluded.has(symbol.toLowerCase())));
}

export function stockMoveThreshold(symbol: string): number {
  return ETF_SYMBOLS.has(symbol) ? 3 : 5;
}

export function isStockMover(row: StockQuoteRow): boolean {
  return row.price != null && row.changePct != null && Math.abs(row.changePct) >= row.threshold;
}

function formatStockLine(row: StockQuoteRow, flagMover = true): string {
  const asOf =
    row.marketTime != null && Number.isFinite(row.marketTime)
      ? ` @${formatDisplayShortTime(new Date(row.marketTime * 1000))}`
      : "";
  if (row.price == null) return `  ${row.name}(${row.symbol}): N/A`;
  if (row.changePct == null) {
    return `  ${row.name}(${row.symbol}): ${formatStockPrice(row.symbol, row.price)} (涨跌幅 N/A)${asOf}`;
  }
  const flag = flagMover && Math.abs(row.changePct) >= row.threshold ? " ⚠️" : "";
  const sign = row.changePct >= 0 ? "+" : "";
  return `  ${row.name}(${row.symbol}): ${formatStockPrice(row.symbol, row.price)} (${sign}${row.changePct.toFixed(2)}%)${flag}${asOf}`;
}

/**
 * Morning-brief stock layout: movers first (by |Δ|), fold quiet names into one line.
 * When nothing crosses the threshold, still show the top few relative actives.
 */
export function formatStocksSectionLines(
  rows: StockQuoteRow[],
  options: { quietTopN?: number; showAll?: boolean } = {},
): string[] {
  const quietTopN = options.quietTopN ?? 3;
  const lines = ["📈 股票/ETF\n"];
  if (!rows.length) {
    lines.push("  自选为空");
    return lines;
  }

  if (options.showAll) {
    for (const row of rows) lines.push(formatStockLine(row));
    return lines;
  }

  const missing = rows.filter((row) => row.price == null);
  const withChange = rows.filter((row) => row.price != null && row.changePct != null);
  const unknownChg = rows.filter((row) => row.price != null && row.changePct == null);
  const movers = withChange.filter(isStockMover).sort((a, b) => Math.abs(b.changePct!) - Math.abs(a.changePct!));
  const quiet = withChange
    .filter((row) => !isStockMover(row))
    .sort((a, b) => Math.abs(b.changePct!) - Math.abs(a.changePct!));

  if (movers.length) {
    lines.push(...movers.map((row) => formatStockLine(row, true)));
  } else if (quiet.length) {
    lines.push(`  今日自选均未达异动阈值（个股 ≥5% / 指数·ETF ≥3%）；相对活跃：`);
    for (const row of quiet.slice(0, quietTopN)) lines.push(formatStockLine(row, false));
  } else if (!unknownChg.length && !missing.length) {
    lines.push("  暂无可用报价");
  }

  if (quiet.length && movers.length) {
    const sample = quiet
      .slice(0, 2)
      .map((row) => {
        const sign = row.changePct! >= 0 ? "+" : "";
        return `${row.symbol} ${sign}${row.changePct!.toFixed(1)}%`;
      })
      .join("、");
    const more = quiet.length > 2 ? " 等" : "";
    lines.push(`  其余 ${quiet.length} 只未达阈值${sample ? `（如 ${sample}${more}）` : ""}`);
  }

  if (unknownChg.length) {
    lines.push(`  涨跌幅缺失: ${unknownChg.map((row) => row.symbol).join("、")}`);
  }
  if (missing.length) {
    lines.push(`  报价失败: ${missing.map((row) => row.symbol).join("、")}`);
  }
  return lines;
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
  const showAll = dotGet(config, "briefing.stocks_show_all", false) === true;

  const entries = Object.entries(wl);
  const rows = await Promise.all(
    entries.map(async ([symbol, name]): Promise<StockQuoteRow> => {
      const q = await stockQuote(symbol);
      return {
        symbol,
        name,
        price: q.price ?? null,
        changePct: q.change_pct ?? null,
        marketTime: q.market_time ?? null,
        threshold: stockMoveThreshold(symbol),
      };
    }),
  );

  return formatStocksSectionLines(rows, { showAll }).join("\n");
}
