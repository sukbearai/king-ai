import { dotGet, loadTradeConfig } from "./config.js";
import {
  buildYieldHighContext,
  classifyPriceDropSeverity,
  classifyYieldRiseSeverity,
  fetchTreasuryPriceQuote,
  fetchTreasuryYieldQuote,
  fetchYieldPeriodHigh,
  formatTreasuryBriefLine,
  parseTreasuryConfig,
  type TreasuryConfig,
  type TreasuryPriceQuote,
  type TreasuryYieldQuote,
} from "./treasury-helpers.js";

export async function fetchTreasurySection(): Promise<string> {
  const config = await loadTradeConfig();
  const cfg = parseTreasuryConfig(dotGet(config, "treasury", {}));
  const lines = ["📉 美债 / 收益率\n"];
  const priceQuotes: TreasuryPriceQuote[] = [];
  const yieldQuotes: TreasuryYieldQuote[] = [];
  const missing: string[] = [];

  for (const [symbol, name] of Object.entries(cfg.price_watchlist)) {
    const quote = await fetchTreasuryPriceQuote(symbol);
    if (quote) priceQuotes.push(quote);
    else missing.push(`${name}(${symbol})`);
    lines.push(formatTreasuryBriefLine(name, symbol, quote, null, null, cfg));
  }

  for (const [symbol, name] of Object.entries(cfg.yield_watchlist)) {
    const quote = await fetchTreasuryYieldQuote(symbol);
    if (quote) yieldQuotes.push(quote);
    else missing.push(`${name}(${symbol})`);
    let highCtx = null;
    if (quote) {
      const periodHigh = await fetchYieldPeriodHigh(symbol, cfg.yield_high_lookback_years);
      if (periodHigh != null) {
        highCtx = buildYieldHighContext(
          symbol,
          quote.yield_pct,
          periodHigh,
          cfg.yield_high_lookback_years,
          cfg.yield_near_high_bps,
        );
      }
    }
    lines.push(formatTreasuryBriefLine(name, symbol, null, quote, highCtx, cfg));
  }

  lines.push("");
  if (missing.length) lines.push(`  ⚠️ 数据降级: ${missing.join("、")} 获取失败`);
  lines.push(`  ${buildTreasuryBriefConclusion(priceQuotes, yieldQuotes, cfg, missing)}`);
  return lines.join("\n");
}

export function buildTreasuryBriefConclusion(
  priceQuotes: TreasuryPriceQuote[],
  yieldQuotes: TreasuryYieldQuote[],
  cfg: TreasuryConfig,
  missing: string[] = [],
): string {
  const priceTightening = priceQuotes.some((quote) => classifyPriceDropSeverity(quote.change_pct, cfg) !== "none");
  const yieldTightening = yieldQuotes.some((quote) => classifyYieldRiseSeverity(quote.change_bps, cfg) !== "none");
  const priceEasing = priceQuotes.some((quote) => quote.change_pct >= cfg.price_drop_warning_pct);
  const yieldEasing = yieldQuotes.some((quote) => quote.change_bps <= -cfg.yield_rise_warning_bps);
  const tightening = priceTightening || yieldTightening;
  const easing = priceEasing || yieldEasing;

  let conclusion: string;
  if (!priceQuotes.length && !yieldQuotes.length) {
    conclusion = "结论: 数据不完整，暂不判断降息预期方向";
  } else if (tightening && easing) {
    conclusion = "结论: 长债价格与收益率信号分化，降息预期方向不明";
  } else if (tightening) {
    conclusion = "结论: 长债承压或收益率明显上行，降息预期边际降温";
  } else if (easing) {
    conclusion = "结论: 长债走强或收益率明显回落，降息预期边际升温";
  } else {
    conclusion = "结论: 长债价格与收益率波动有限，降息预期信号中性";
  }

  if (missing.length && (priceQuotes.length || yieldQuotes.length)) {
    return `${conclusion}；${missing.join("、")} 数据不完整，需谨慎解读`;
  }
  if (missing.length) return `${conclusion}（缺失: ${missing.join("、")} ）`;
  return conclusion;
}
