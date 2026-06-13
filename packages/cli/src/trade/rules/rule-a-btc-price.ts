import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { nowDisplay, okxGet } from "../data-helpers.js";

export function createRuleA(threshold = 1.2): AlertRule {
  return {
    name: "btc_price_move",
    ruleKey: "a",
    defaultCooldown: 600,
    async check(state: AlertState): Promise<Alert[]> {
      const alerts: Alert[] = [];
      const resp = await okxGet("/api/v5/market/candles", {
        instId: "BTC-USDT",
        bar: "1H",
        limit: "2"
      });
      const candles = resp.data as unknown[] | undefined;
      if (!candles?.length || !Array.isArray(candles[0]) || (candles[0] as unknown[]).length < 5) {
        return alerts;
      }

      const candle = candles[0] as string[];
      const openPrice = Number.parseFloat(candle[1] ?? "0");
      const closePrice = Number.parseFloat(candle[4] ?? "0");
      if (!Number.isFinite(openPrice) || !Number.isFinite(closePrice) || openPrice <= 0 || closePrice <= 0) {
        return alerts;
      }

      const changePct = ((closePrice - openPrice) / openPrice) * 100;
      if (Math.abs(changePct) < threshold) return alerts;

      const direction = changePct > 0 ? "暴涨" : "暴跌";
      const severity = Math.abs(changePct) >= 3 ? "critical" : "warning";
      const candleTs = candle[0] ?? String(Math.floor(Date.now() / 3600000));
      const key = `btc_move_${severity}_${direction}_${candleTs}`;
      if (!state.canAlert(key, 7200)) return alerts;

      const sigDir = changePct > 0 ? 1 : -1;
      const sigStr = Math.min(Math.abs(changePct) / 5, 1);
      alerts.push(createAlert({
        rule: "价格异动",
        severity,
        title: `BTC ${direction} ${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}% (1h)`,
        detail: `当前: $${closePrice.toLocaleString("en-US", { maximumFractionDigits: 0 })} | 1h开盘: $${openPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
        timestamp: nowDisplay(),
        direction: sigDir,
        strength: sigStr,
        asset: "BTC"
      }));
      return alerts;
    }
  };
}