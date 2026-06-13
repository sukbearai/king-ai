import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { blockbeatsBtcEtf, nowDisplay } from "../data-helpers.js";

export function createRuleU(
  criticalDayThreshold = 500,
  warningDayThreshold = 200,
  sustained3dThreshold = 800,
  staleDays = 5
): AlertRule {
  return {
    name: "etf_flow",
    ruleKey: "u",
    defaultCooldown: 21600,
    async check(state: AlertState): Promise<Alert[]> {
      const series = await blockbeatsBtcEtf();
      if (!series.length) return [];

      const latest = series[series.length - 1]!;
      const latestDate = latest.date;
      const dayNet = latest.day_net_inflow;

      const ageDays = (() => {
        try {
          const d = new Date(`${latestDate}T00:00:00Z`);
          return Math.floor((Date.now() - d.getTime()) / 86400000);
        } catch {
          return staleDays + 1;
        }
      })();
      if (ageDays > staleDays) return [];

      const alerts: Alert[] = [];
      const absDay = Math.abs(dayNet);

      if (absDay >= warningDayThreshold) {
        const severity: Alert["severity"] = absDay >= criticalDayThreshold ? "critical" : "warning";
        const direction = dayNet > 0 ? 1 : -1;
        const verb = dayNet > 0 ? "净流入" : "净流出";
        const alertKey = `u_day_${latestDate}_${severity}`;
        if (state.canAlert(alertKey, 86400)) {
          const interpret = dayNet > 0
            ? (severity === "critical" ? "机构强力买入信号，关注 BTC 上行动能" : "机构温和买入")
            : (severity === "critical" ? "机构大额抛售，警惕短期下行压力" : "机构温和减仓");
          alerts.push(createAlert({
            rule: "BTC ETF 单日流向",
            severity,
            title: `BTC ETF ${latestDate} ${verb} $${absDay.toFixed(1)}M`,
            detail: `日期: ${latestDate}\n单日净流入: $${dayNet >= 0 ? "+" : ""}${dayNet.toFixed(2)}M\n累计净流入: $${latest.total_net_inflow.toFixed(0)}M\n阈值: warning ≥$${warningDayThreshold}M, critical ≥$${criticalDayThreshold}M\n解读: ${interpret}`,
            timestamp: nowDisplay(),
            direction,
            strength: Math.min(absDay / 1000, 1),
            asset: "BTC"
          }));
        }
      }

      if (series.length >= 3) {
        const last3 = series.slice(-3);
        const sum3 = last3.reduce((a, r) => a + r.day_net_inflow, 0);
        const absSum3 = Math.abs(sum3);
        if (absSum3 >= sustained3dThreshold) {
          const signs = last3.map((r) => (r.day_net_inflow > 0 ? 1 : r.day_net_inflow < 0 ? -1 : 0)).filter((s) => s !== 0);
          const consistent = new Set(signs).size === 1;
          if (consistent) {
            const direction = sum3 > 0 ? 1 : -1;
            const verb = sum3 > 0 ? "持续净流入" : "持续净流出";
            const dayBreakdown = last3.map((r) => `${r.date.slice(-5)}=${r.day_net_inflow >= 0 ? "+" : ""}${r.day_net_inflow.toFixed(0)}`).join(" / ");
            const alertKey = `u_3d_${latestDate}`;
            if (state.canAlert(alertKey, 86400)) {
              const interpret = sum3 > 0
                ? "连续 3 日正流入，机构累积买入趋势确立"
                : "连续 3 日负流出，机构连续减仓需警惕";
              alerts.push(createAlert({
                rule: "BTC ETF 3日趋势",
                severity: "warning",
                title: `BTC ETF 3日${verb} $${absSum3.toFixed(0)}M (截至 ${latestDate})`,
                detail: `3日合计: $${sum3 >= 0 ? "+" : ""}${sum3.toFixed(1)}M\n逐日: ${dayBreakdown}\n阈值: |3日和| ≥$${sustained3dThreshold}M\n解读: ${interpret}`,
                timestamp: nowDisplay(),
                direction,
                strength: Math.min(absSum3 / 2000, 1),
                asset: "BTC"
              }));
            }
          }
        }
      }

      return alerts;
    }
  };
}