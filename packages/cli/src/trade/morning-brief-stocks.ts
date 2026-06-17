import { dotGet, loadTradeConfig } from "./config.js";
import { stockQuote } from "./data-helpers.js";

const DEFAULT_WATCHLIST: Record<string, string> = {
  CRCL: "Circle",
  PDD: "拼多多",
  GLD: "黄金ETF",
  "01810": "小米",
  RKLB: "Rocket Lab",
  TSLA: "特斯拉",
  NVDA: "英伟达"
};

const ETF_SYMBOLS = new Set(["GLD", "SH000001", "SZ399001"]);

export async function fetchStocksSection(): Promise<string> {
  const config = await loadTradeConfig();
  const wl = (dotGet(config, "stocks.watchlist", DEFAULT_WATCHLIST) ?? DEFAULT_WATCHLIST) as Record<string, string>;
  const lines = ["📈 股票/ETF\n"];

  for (const [symbol, name] of Object.entries(wl)) {
    const q = await stockQuote(symbol);
    if (!q.price) {
      lines.push(`  ${name}(${symbol}): N/A`);
      continue;
    }
    const threshold = ETF_SYMBOLS.has(symbol) ? 3 : 5;
    const chg = q.change_pct;
    if (chg == null) {
      lines.push(`  ${name}(${symbol}): $${q.price.toFixed(2)} (涨跌幅 N/A)`);
      continue;
    }
    const flag = Math.abs(chg) >= threshold ? " ⚠️" : "";
    lines.push(`  ${name}(${symbol}): $${q.price.toFixed(2)} (${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%)${flag}`);
  }
  return lines.join("\n");
}
