import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { dotGet, loadTradeConfig } from "../config.js";
import { nowDisplay } from "../data-helpers.js";
import {
  buildYieldHighContext,
  classifyPriceDropSeverity,
  classifyYieldRiseSeverity,
  fetchTreasuryPriceQuote,
  fetchTreasuryYieldQuote,
  fetchYieldPeriodHigh,
  formatYieldPct,
  parseTreasuryConfig,
  type TreasuryConfig,
} from "../treasury-helpers.js";

// 20h blocks same-session repeats without locking out the next day's session.
const REALERT_COOLDOWN_SECONDS = 72_000;

function sellingPressureDetail(name: string, symbol: string, changePct: number, price: number): string {
  return [
    `${name}（${symbol}）价格下跌 ${Math.abs(changePct).toFixed(2)}%，反映市场在抛售长期美债。`,
    `债券价格 ↓ → 收益率 ↑ → 降息预期降温 / 加息担忧升温。`,
    `现价: $${price.toFixed(2)}`,
  ].join("\n");
}

function yieldSpikeDetail(
  name: string,
  symbol: string,
  yieldPct: number,
  changeBps: number,
  highCtx?: {
    lookback_years: number;
    period_high_pct: number;
    is_new_high: boolean;
    is_near_high: boolean;
    bps_below_high: number;
  },
): string {
  const lines = [
    `${name}升至 ${formatYieldPct(yieldPct)}，日内上行 ${changeBps.toFixed(1)}bp。`,
    `收益率飙升通常由抛售美债驱动，而非经济走强本身。`,
  ];
  if (highCtx?.is_new_high) {
    lines.push(`已刷新近 ${highCtx.lookback_years} 年最高水平（前高 ${formatYieldPct(highCtx.period_high_pct)}）。`);
  } else if (highCtx?.is_near_high) {
    lines.push(
      `逼近近 ${highCtx.lookback_years} 年高点 ${formatYieldPct(highCtx.period_high_pct)}（仅差 ${Math.abs(highCtx.bps_below_high).toFixed(1)}bp）。`,
    );
  }
  lines.push(`标的: ${symbol}`);
  return lines.join("\n");
}

export function createRuleB(): AlertRule {
  return {
    name: "treasury_stress",
    ruleKey: "treasury",
    defaultCooldown: 3600,
    async check(state: AlertState): Promise<Alert[]> {
      const config = await loadTradeConfig();
      const cfg = parseTreasuryConfig(dotGet(config, "treasury", {}));
      const alerts: Alert[] = [];

      for (const [symbol, name] of Object.entries(cfg.price_watchlist)) {
        const quote = await fetchTreasuryPriceQuote(symbol);
        if (!quote) continue;
        const severity = classifyPriceDropSeverity(quote.change_pct, cfg);
        if (severity === "none") continue;
        const key = `treasury_price_${symbol}_${severity}`;
        if (!state.canAlert(key, REALERT_COOLDOWN_SECONDS)) continue;
        alerts.push(
          createAlert({
            ruleId: "treasury",
            severity,
            title: `${name} ${quote.change_pct.toFixed(2)}%（抛售压力）`,
            detail: sellingPressureDetail(name, symbol, quote.change_pct, quote.price),
            timestamp: nowDisplay(),
            direction: -1,
            strength: Math.min(Math.abs(quote.change_pct) / 3, 1),
            asset: symbol,
            tags: ["treasury", "price", "fed-expectations"],
            cooldownKey: key,
          }),
        );
      }

      for (const [symbol, name] of Object.entries(cfg.yield_watchlist)) {
        const quote = await fetchTreasuryYieldQuote(symbol);
        if (!quote) continue;

        const riseSeverity = classifyYieldRiseSeverity(quote.change_bps, cfg);
        const periodHigh = await fetchYieldPeriodHigh(symbol, cfg.yield_high_lookback_years);
        const highCtx =
          periodHigh == null
            ? null
            : buildYieldHighContext(
                symbol,
                quote.yield_pct,
                periodHigh,
                cfg.yield_high_lookback_years,
                cfg.yield_near_high_bps,
              );

        const highSeverity = highCtx?.is_new_high ? "critical" : highCtx?.is_near_high ? "warning" : "none";

        const severity = maxSeverity(riseSeverity, highSeverity);
        if (severity === "none") continue;

        const key = `treasury_yield_${symbol}_${severity}`;
        if (!state.canAlert(key, highCtx?.is_new_high ? 86_400 : REALERT_COOLDOWN_SECONDS)) continue;

        const title = highCtx?.is_new_high
          ? `${name} ${formatYieldPct(quote.yield_pct)} 刷新${highCtx.lookback_years}年新高`
          : highCtx?.is_near_high
            ? `${name} ${formatYieldPct(quote.yield_pct)} 逼近阶段高点`
            : `${name}飙升 ${quote.change_bps.toFixed(1)}bp`;

        alerts.push(
          createAlert({
            ruleId: "treasury",
            severity,
            title,
            detail: yieldSpikeDetail(name, symbol, quote.yield_pct, quote.change_bps, highCtx ?? undefined),
            timestamp: nowDisplay(),
            direction: 1,
            strength: Math.min(Math.max(quote.change_bps / 15, highCtx?.is_new_high ? 0.9 : 0.4), 1),
            asset: symbol.replace(/^\^/, ""),
            tags: ["treasury", "yield", "fed-expectations"],
            cooldownKey: key,
          }),
        );
      }

      return alerts;
    },
  };
}

function maxSeverity(
  a: "none" | "warning" | "critical",
  b: "none" | "warning" | "critical",
): "none" | "warning" | "critical" {
  const rank = { none: 0, warning: 1, critical: 2 };
  return rank[a] >= rank[b] ? a : b;
}
