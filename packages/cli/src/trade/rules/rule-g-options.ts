import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { nowDisplay, surfOptionsData } from "../data-helpers.js";
import { getScratchpad } from "../scratchpad.js";

export function createRuleG(pcrHigh = 1.5, pcrLow = 0.4): AlertRule {
  let lastTotalVol = 0;

  return {
    name: "options_flow",
    ruleKey: "g",
    defaultCooldown: 3600,
    async check(state: AlertState): Promise<Alert[]> {
      const alerts: Alert[] = [];
      const regime = await getScratchpad().getRegime();
      const bearishSuppress = regime === "risk_on";
      const bearishCap = regime !== "risk_off" && regime !== "risk_on" ? "info" as const : null;

      const rows = await surfOptionsData("BTC");
      if (!rows.length) return alerts;

      let totalRow: Record<string, unknown> | null = null;
      const exchangeRows: Array<Record<string, unknown>> = [];
      for (const row of rows) {
        if (row.exchange === "All") totalRow = row;
        else exchangeRows.push(row);
      }
      if (!totalRow) return alerts;

      const totalOi = Number(totalRow.open_interest ?? 0);
      const totalVol = Number(totalRow.volume_24h ?? 0);

      for (const ex of exchangeRows) {
        const pcr = ex.put_call_ratio;
        if (pcr == null) continue;
        const pcrNum = Number(pcr);
        const exchange = String(ex.exchange ?? "?");
        const maxPain = ex.max_pain_price != null ? Number(ex.max_pain_price) : null;
        const oi = Number(ex.open_interest ?? 0);
        const vol = Number(ex.volume_24h ?? 0);
        const oiStr = oi >= 1e9 ? `$${(oi / 1e9).toFixed(1)}B` : `$${(oi / 1e6).toFixed(0)}M`;
        const volStr = vol >= 1e9 ? `$${(vol / 1e9).toFixed(1)}B` : `$${(vol / 1e6).toFixed(0)}M`;

        if (pcrNum >= pcrHigh) {
          if (bearishSuppress) continue;
          const alertKey = `pcr_bearish_${exchange}`;
          if (state.canAlert(alertKey, 3600)) {
            let severity: Alert["severity"] = pcrNum >= 2.5 ? "warning" : "info";
            if (bearishCap && severity !== "info") severity = bearishCap;
            const mpStr = maxPain != null ? `\nMax Pain: $${maxPain.toLocaleString()}` : "";
            alerts.push(createAlert({
              rule: "期权异常",
              severity,
              title: `BTC ${exchange} Put/Call=${pcrNum.toFixed(2)} 看跌情绪升温`,
              detail: `交易所: ${exchange}\nPut/Call Ratio: ${pcrNum.toFixed(2)} (阈值 >${pcrHigh})\nOI: ${oiStr} | 24h Vol: ${volStr}${mpStr}\n解读: Put 期权交易量远超 Call，机构对冲/看跌情绪偏重`,
              timestamp: nowDisplay(),
              direction: -1,
              strength: Math.min(pcrNum / 3, 1),
              asset: "BTC"
            }));
          }
        } else if (pcrNum <= pcrLow) {
          const alertKey = `pcr_bullish_${exchange}`;
          if (state.canAlert(alertKey, 3600)) {
            const severity: Alert["severity"] = pcrNum <= 0.2 ? "warning" : "info";
            const mpStr = maxPain != null ? `\nMax Pain: $${maxPain.toLocaleString()}` : "";
            alerts.push(createAlert({
              rule: "期权异常",
              severity,
              title: `BTC ${exchange} Put/Call=${pcrNum.toFixed(2)} 看涨情绪高涨`,
              detail: `交易所: ${exchange}\nPut/Call Ratio: ${pcrNum.toFixed(2)} (阈值 <${pcrLow})\nOI: ${oiStr} | 24h Vol: ${volStr}${mpStr}\n解读: Call 期权交易量远超 Put，市场看涨情绪强烈`,
              timestamp: nowDisplay(),
              direction: 1,
              strength: Math.min((pcrLow - pcrNum + 0.1) / 0.5, 1),
              asset: "BTC"
            }));
          }
        }
      }

      if (lastTotalVol > 0 && totalVol > 0) {
        const volChange = ((totalVol - lastTotalVol) / lastTotalVol) * 100;
        if (volChange >= 50) {
          const alertKey = `opt_vol_surge_${Math.floor(totalVol / 1e9)}`;
          if (state.canAlert(alertKey, 3600)) {
            alerts.push(createAlert({
              rule: "期权异常",
              severity: volChange >= 100 ? "warning" : "info",
              title: `BTC 期权成交量激增 +${volChange.toFixed(0)}%`,
              detail: `24h Vol: $${(lastTotalVol / 1e9).toFixed(1)}B → $${(totalVol / 1e9).toFixed(1)}B (+${volChange.toFixed(0)}%)\nTotal OI: $${(totalOi / 1e9).toFixed(1)}B\n解读: 期权市场活跃度大幅提升，可能有大事件博弈`,
              timestamp: nowDisplay(),
              direction: 0,
              strength: Math.min(volChange / 200, 1),
              asset: "BTC"
            }));
          }
        }
      }
      lastTotalVol = totalVol;
      return alerts;
    }
  };
}