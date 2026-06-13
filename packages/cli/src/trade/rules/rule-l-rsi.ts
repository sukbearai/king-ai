import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { nowDisplay, okxGet, okxPost } from "../data-helpers.js";
import { getScratchpad } from "../scratchpad.js";

const RSI_WATCHLIST: Record<string, string> = {
  "BTC-USDT": "BTC",
  "ETH-USDT": "ETH",
  "SOL-USDT": "SOL"
};

const RSI_PERIOD = 14;

const RSI_TIMEFRAMES: Record<string, { bar: string; cooldown: number; label: string }> = {
  "1H": { bar: "1H", cooldown: 3600, label: "1小时" },
  "4H": { bar: "4H", cooldown: 14400, label: "4小时" }
};

const OVERBOUGHT = 70;
const EXTREME_OVERBOUGHT = 80;
const OVERSOLD = 30;
const EXTREME_OVERSOLD = 20;

export function createRuleL(): AlertRule {
  const prevRsi: Record<string, number | undefined> = {};

  return {
    name: "rsi_extremes",
    ruleKey: "l",
    defaultCooldown: 3600,
    async check(state: AlertState): Promise<Alert[]> {
      const alerts: Alert[] = [];
      const regime = await getScratchpad().getRegime();
      const bearishSuppress = regime === "risk_on";
      const bearishCap = regime !== "risk_off" && regime !== "risk_on" ? "info" : null;

      for (const [tfKey, tfCfg] of Object.entries(RSI_TIMEFRAMES)) {
        const { bar, cooldown: tfCooldown, label: tfLabel } = tfCfg;

        for (const [instId, name] of Object.entries(RSI_WATCHLIST)) {
          const rsiRows = await fetchRsi(instId, bar);
          if (!rsiRows?.length) continue;

          const latestRow = rsiRows[rsiRows.length - 1]!;
          const vals = (latestRow.values ?? latestRow) as Record<string, string>;
          const rsiVal = Number.parseFloat(vals[String(RSI_PERIOD)] ?? "0");
          if (!Number.isFinite(rsiVal) || rsiVal <= 0) continue;

          const stateKey = `${name}_${tfKey}`;
          const prev = prevRsi[stateKey];
          prevRsi[stateKey] = rsiVal;

          if (prev === undefined) continue;

          const price = await fetchPrice(instId);
          const priceStr = price ? `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "N/A";

          if (rsiVal > OVERBOUGHT && prev <= OVERBOUGHT && !bearishSuppress) {
            const extreme = rsiVal > EXTREME_OVERBOUGHT;
            let severity: "info" | "warning" | "critical" = extreme ? "critical" : "info";
            if (bearishCap && severity !== "info") severity = bearishCap;

            const alertKey = `rsi_ob_${name}_${tfKey}`;
            if (state.canAlert(alertKey, tfCooldown)) {
              const zone = extreme ? "极度超买" : "超买";
              alerts.push(createAlert({
                rule: "RSI超买",
                severity,
                title: `${name} RSI ${zone}（${tfLabel}）`,
                detail: [
                  `RSI(${RSI_PERIOD}): ${rsiVal.toFixed(1)}`,
                  `价格: ${priceStr}`,
                  `周期: ${tfLabel}`,
                  `前值: ${prev.toFixed(1)}`,
                  `阈值: ${extreme ? `>${EXTREME_OVERBOUGHT}` : `>${OVERBOUGHT}`}`,
                  `信号: 短期回调风险${extreme ? "极高" : "偏高"}`
                ].join("\n"),
                timestamp: nowDisplay(),
                direction: -0.7,
                strength: Math.min((rsiVal - OVERBOUGHT) / 30, 1),
                asset: name
              }));
            }
          } else if (
            rsiVal > EXTREME_OVERBOUGHT &&
            prev <= EXTREME_OVERBOUGHT &&
            prev > OVERBOUGHT &&
            !bearishSuppress
          ) {
            let severity: "info" | "warning" | "critical" = "critical";
            if (bearishCap) severity = bearishCap;

            const alertKey = `rsi_eob_${name}_${tfKey}`;
            if (state.canAlert(alertKey, tfCooldown)) {
              alerts.push(createAlert({
                rule: "RSI超买",
                severity,
                title: `${name} RSI 极度超买（${tfLabel}）`,
                detail: [
                  `RSI(${RSI_PERIOD}): ${rsiVal.toFixed(1)}`,
                  `价格: ${priceStr}`,
                  `周期: ${tfLabel}`,
                  `前值: ${prev.toFixed(1)}`,
                  `阈值: >${EXTREME_OVERBOUGHT}`,
                  "信号: 短期回调风险极高"
                ].join("\n"),
                timestamp: nowDisplay(),
                direction: -0.7,
                strength: Math.min((rsiVal - OVERBOUGHT) / 30, 1),
                asset: name
              }));
            }
          }

          if (rsiVal < OVERSOLD && prev >= OVERSOLD) {
            const extreme = rsiVal < EXTREME_OVERSOLD;
            let severity: "info" | "warning" | "critical";
            if (extreme) severity = "critical";
            else if (tfKey === "4H") severity = "warning";
            else severity = "info";

            const alertKey = `rsi_os_${name}_${tfKey}`;
            if (state.canAlert(alertKey, tfCooldown)) {
              const zone = extreme ? "极度超卖" : "超卖";
              alerts.push(createAlert({
                rule: "RSI超卖",
                severity,
                title: `${name} RSI ${zone}（${tfLabel}）`,
                detail: [
                  `RSI(${RSI_PERIOD}): ${rsiVal.toFixed(1)}`,
                  `价格: ${priceStr}`,
                  `周期: ${tfLabel}`,
                  `前值: ${prev.toFixed(1)}`,
                  `阈值: ${extreme ? `<${EXTREME_OVERSOLD}` : `<${OVERSOLD}`}`,
                  `信号: 超卖反弹机会${extreme ? "极强" : "偏强"}`
                ].join("\n"),
                timestamp: nowDisplay(),
                direction: 0.7,
                strength: Math.min((OVERSOLD - rsiVal) / 30, 1),
                asset: name
              }));
            }
          } else if (rsiVal < EXTREME_OVERSOLD && prev >= EXTREME_OVERSOLD && prev < OVERSOLD) {
            const alertKey = `rsi_eos_${name}_${tfKey}`;
            if (state.canAlert(alertKey, tfCooldown)) {
              alerts.push(createAlert({
                rule: "RSI超卖",
                severity: "critical",
                title: `${name} RSI 极度超卖（${tfLabel}）`,
                detail: [
                  `RSI(${RSI_PERIOD}): ${rsiVal.toFixed(1)}`,
                  `价格: ${priceStr}`,
                  `周期: ${tfLabel}`,
                  `前值: ${prev.toFixed(1)}`,
                  `阈值: <${EXTREME_OVERSOLD}`,
                  "信号: 超卖反弹机会极强"
                ].join("\n"),
                timestamp: nowDisplay(),
                direction: 0.7,
                strength: Math.min((OVERSOLD - rsiVal) / 30, 1),
                asset: name
              }));
            }
          }
        }
      }

      return alerts;
    }
  };
}

async function fetchRsi(instId: string, bar: string): Promise<Array<Record<string, unknown>> | null> {
  const resp = await okxPost("/api/v5/aigc/mcp/indicators", {
    instId,
    timeframes: [bar],
    indicators: {
      RSI: { paramList: [RSI_PERIOD], returnList: true, limit: 2 }
    }
  });
  try {
    const outer = resp.data as Array<{ data?: unknown[] }> | undefined;
    if (!outer?.length) return null;
    const inner = outer[0]!.data as Array<{
      timeframes?: Record<string, { indicators?: { RSI?: Array<Record<string, unknown>> } }>;
    }>;
    if (!inner?.length) return null;
    return inner[0]!.timeframes?.[bar]?.indicators?.RSI ?? null;
  } catch {
    return null;
  }
}

async function fetchPrice(instId: string): Promise<number | null> {
  const resp = await okxGet("/api/v5/market/candles", {
    instId,
    bar: "1m",
    limit: "1"
  });
  try {
    const data = resp.data as string[][] | undefined;
    if (data?.length && data[0]!.length >= 5) {
      const price = Number.parseFloat(data[0]![4] ?? "0");
      if (Number.isFinite(price)) return price;
    }
  } catch {
    // ignore
  }
  return null;
}