import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { nowDisplay, yahooFinanceQuote } from "../data-helpers.js";

export function createRuleJ(spikePct = 10): AlertRule {
  let lastVix = 0;

  return {
    name: "vix_spike",
    ruleKey: "j",
    defaultCooldown: 600,
    async check(state: AlertState): Promise<Alert[]> {
      const alerts: Alert[] = [];
      const yf = await yahooFinanceQuote("^VIX");
      const vixNow = yf.price;
      if (vixNow <= 0) return alerts;

      const vixPrev = lastVix;
      lastVix = vixNow;

      if (vixPrev <= 0) return alerts;

      const pctChange = ((vixNow - vixPrev) / vixPrev) * 100;

      if (pctChange >= spikePct) {
        const alertKey = `vix_spike_${Math.floor(Date.now() / 600000)}`;
        if (state.canAlert(alertKey, 600)) {
          const severity = pctChange >= 50 || vixNow >= 40 ? "critical" : "warning";
          alerts.push(createAlert({
            rule: "VIX 飙升",
            severity,
            title: `VIX 恐慌指数飙升 ${vixPrev.toFixed(1)} → ${vixNow.toFixed(1)} (+${pctChange.toFixed(1)}%)`,
            detail: [
              `当前 VIX: ${vixNow.toFixed(2)}`,
              `上次 VIX: ${vixPrev.toFixed(2)}`,
              `涨幅: +${pctChange.toFixed(1)}%`,
              `阈值: ${spikePct}%`
            ].join("\n"),
            timestamp: nowDisplay(),
            direction: -1,
            strength: Math.min(pctChange / 20, 1),
            asset: "VIX"
          }));
        }
      }

      if (vixNow >= 35) {
        if (state.canAlert("vix_high", 3600)) {
          alerts.push(createAlert({
            rule: "VIX 高位",
            severity: vixNow >= 45 ? "critical" : "warning",
            title: `VIX 处于恐慌高位: ${vixNow.toFixed(2)}`,
            detail: "VIX ≥ 35 表示市场极度恐慌，注意风险管理",
            timestamp: nowDisplay(),
            direction: -1,
            strength: Math.min(vixNow / 50, 1),
            asset: "VIX"
          }));
        }
      }

      return alerts;
    }
  };
}