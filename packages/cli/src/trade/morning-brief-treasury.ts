import { dotGet, loadTradeConfig } from "./config.js";
import {
  buildYieldHighContext,
  fetchTreasuryPriceQuote,
  fetchTreasuryYieldQuote,
  fetchYieldPeriodHigh,
  formatTreasuryBriefLine,
  parseTreasuryConfig
} from "./treasury-helpers.js";

export async function fetchTreasurySection(): Promise<string> {
  const config = await loadTradeConfig();
  const cfg = parseTreasuryConfig(dotGet(config, "treasury", {}));
  const lines = ["📉 美债 / 收益率\n"];

  for (const [symbol, name] of Object.entries(cfg.price_watchlist)) {
    const quote = await fetchTreasuryPriceQuote(symbol);
    lines.push(formatTreasuryBriefLine(name, symbol, quote, null, null, cfg));
  }

  for (const [symbol, name] of Object.entries(cfg.yield_watchlist)) {
    const quote = await fetchTreasuryYieldQuote(symbol);
    let highCtx = null;
    if (quote) {
      const periodHigh = await fetchYieldPeriodHigh(symbol, cfg.yield_high_lookback_years);
      if (periodHigh != null) {
        highCtx = buildYieldHighContext(
          symbol,
          quote.yield_pct,
          periodHigh,
          cfg.yield_high_lookback_years,
          cfg.yield_near_high_bps
        );
      }
    }
    lines.push(formatTreasuryBriefLine(name, symbol, null, quote, highCtx, cfg));
  }

  lines.push("");
  lines.push("  逻辑: 抛售长期美债 → 价格↓ / 收益率↑ → 降息预期降温");
  return lines.join("\n");
}