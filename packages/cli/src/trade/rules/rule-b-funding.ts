import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { nowDisplay, okxGet } from "../data-helpers.js";

const INSTRUMENTS = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP"];
const FUNDING_PERIOD_COOLDOWN = 86400;
const THRESH_HIGH_WARN = 0.0003;
const THRESH_HIGH_CRIT = 0.0005;
const THRESH_LOW_WARN = -0.00015;
const THRESH_LOW_CRIT = -0.0003;

function fundingPeriodKey(frData: Record<string, unknown>): string {
  return String(
    frData.fundingTime ??
      frData.nextFundingTime ??
      frData.prevFundingTime ??
      frData.ts ??
      "unknown"
  );
}

export function createRuleB(): AlertRule {
  const prevRates: Record<string, number> = {};

  return {
    name: "funding_rates",
    ruleKey: "b",
    defaultCooldown: 3600,
    async check(state: AlertState): Promise<Alert[]> {
      const alerts: Alert[] = [];
      const highRates: Array<[string, number]> = [];
      const lowRates: Array<[string, number]> = [];

      for (const instId of INSTRUMENTS) {
        const resp = await okxGet("/api/v5/public/funding-rate", { instId });
        const frData = resp.data as Array<Record<string, unknown>> | undefined;
        if (!frData?.length || typeof frData[0] !== "object") continue;

        const symbol = instId.split("-")[0]!;
        const rate = Number.parseFloat(String(frData[0]!.fundingRate ?? "0"));
        if (!Number.isFinite(rate)) continue;

        const periodKey = fundingPeriodKey(frData[0]!);
        const prev = prevRates[symbol];
        prevRates[symbol] = rate;

        if (rate > THRESH_HIGH_WARN && prev !== undefined && prev > THRESH_HIGH_WARN) {
          const severityKey = rate > THRESH_HIGH_CRIT ? "critical" : "warning";
          const alertKey = `fr_high_${severityKey}_${symbol}_${periodKey}`;
          if (state.canAlert(alertKey, FUNDING_PERIOD_COOLDOWN)) {
            highRates.push([symbol, rate]);
          }
        }

        if (rate < THRESH_LOW_WARN && prev !== undefined && prev < THRESH_LOW_WARN) {
          const severityKey = rate < THRESH_LOW_CRIT ? "critical" : "warning";
          const alertKey = `fr_low_${severityKey}_${symbol}_${periodKey}`;
          if (state.canAlert(alertKey, FUNDING_PERIOD_COOLDOWN)) {
            lowRates.push([symbol, rate]);
          }
        }
      }

      if (highRates.length) {
        highRates.sort((a, b) => b[1] - a[1]);
        const [worstSym, worstRate] = highRates[0]!;
        const isCrit = worstRate > THRESH_HIGH_CRIT;
        const severity = isCrit ? "critical" : "warning";
        const rateLines = highRates.map(([sym, r]) => `  ${sym} ${(r * 100).toFixed(4)}%`);
        alerts.push(createAlert({
          rule: "资金费率",
          severity,
          title: `资金费率过高 — ${highRates.map(([s]) => s).join(", ")}`,
          detail: `连续 2 期超过阈值:\n${rateLines.join("\n")}\n多头拥挤，注意回调风险`,
          timestamp: nowDisplay(),
          direction: isCrit ? -0.8 : -0.5,
          strength: Math.min(Math.abs(worstRate) / 0.001, 1),
          asset: worstSym
        }));
      }

      if (lowRates.length) {
        lowRates.sort((a, b) => a[1] - b[1]);
        const [worstSym, worstRate] = lowRates[0]!;
        const isCrit = worstRate < THRESH_LOW_CRIT;
        const severity = isCrit ? "critical" : "warning";
        const rateLines = lowRates.map(([sym, r]) => `  ${sym} ${(r * 100).toFixed(4)}%`);
        alerts.push(createAlert({
          rule: "资金费率",
          severity,
          title: `资金费率极低 — ${lowRates.map(([s]) => s).join(", ")}`,
          detail: `连续 2 期低于阈值:\n${rateLines.join("\n")}\n空头拥挤，注意轧空风险`,
          timestamp: nowDisplay(),
          direction: isCrit ? 0.8 : 0.5,
          strength: Math.min(Math.abs(worstRate) / 0.001, 1),
          asset: worstSym
        }));
      }

      return alerts;
    }
  };
}