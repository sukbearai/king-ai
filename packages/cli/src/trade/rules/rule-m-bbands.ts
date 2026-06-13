import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { nowDisplay, okxGet } from "../data-helpers.js";
import { getScratchpad } from "../scratchpad.js";

const BB_WATCHLIST: Record<string, string> = {
  "BTC-USDT": "BTC",
  "ETH-USDT": "ETH",
  "SOL-USDT": "SOL"
};

const BB_PERIOD = 20;
const BB_STDDEV = 2;

const BB_TIMEFRAMES: Record<string, { bar: string; cooldown: number; label: string }> = {
  "1H": { bar: "1H", cooldown: 3600, label: "1小时" },
  "4H": { bar: "4H", cooldown: 14400, label: "4小时" }
};

const SQUEEZE_THRESHOLDS: Record<string, number> = {
  "1H": 3,
  "4H": 5
};

const VOL_CONFIRM_RATIO = 0.6;
const VOL_LOOKBACK = 10;

interface CandleRow {
  close: number;
  vol: number;
}

interface BollBands {
  upper: number;
  middle: number;
  lower: number;
}

async function fetchCandles(instId: string, bar: string, limit: number): Promise<CandleRow[]> {
  const resp = await okxGet("/api/v5/market/candles", {
    instId,
    bar,
    limit: String(limit)
  });
  const candles: CandleRow[] = [];
  const data = resp.data as string[][] | undefined;
  if (!data) return candles;

  for (const c of [...data].reverse()) {
    if (!Array.isArray(c) || c.length < 6) continue;
    const close = Number.parseFloat(c[4] ?? "0");
    const vol = Number.parseFloat(c[5] ?? "0");
    if (Number.isFinite(close) && Number.isFinite(vol)) {
      candles.push({ close, vol });
    }
  }
  return candles;
}

function computeBollLocal(closes: number[]): BollBands | null {
  if (closes.length < BB_PERIOD) return null;
  const window = closes.slice(-BB_PERIOD);
  const mean = window.reduce((a, b) => a + b, 0) / BB_PERIOD;
  const variance = window.reduce((s, c) => s + (c - mean) ** 2, 0) / BB_PERIOD;
  const stdev = Math.sqrt(variance);
  return {
    upper: mean + BB_STDDEV * stdev,
    middle: mean,
    lower: mean - BB_STDDEV * stdev
  };
}

function volumeConfirmed(candles: CandleRow[]): boolean {
  if (candles.length < 3) return true;
  const recent = candles.slice(0, -1).slice(-VOL_LOOKBACK);
  const currentVol = candles[candles.length - 1]!.vol;
  const avgVol = recent.length ? recent.reduce((s, c) => s + c.vol, 0) / recent.length : 0;
  if (avgVol <= 0) return true;
  return currentVol >= avgVol * VOL_CONFIRM_RATIO;
}

export function createRuleM(): AlertRule {
  return {
    name: "bbands_breakout",
    ruleKey: "m",
    defaultCooldown: 3600,
    async check(state: AlertState): Promise<Alert[]> {
      const alerts: Alert[] = [];
      const regime = await getScratchpad().getRegime();
      const bearishSuppress = regime === "risk_on";
      const bearishCap = regime !== "risk_off" && regime !== "risk_on" ? "info" : null;

      for (const [tfKey, tfCfg] of Object.entries(BB_TIMEFRAMES)) {
        const { bar, cooldown: tfCooldown, label: tfLabel } = tfCfg;
        const squeezeThreshold = SQUEEZE_THRESHOLDS[tfKey]!;

        for (const [instId, name] of Object.entries(BB_WATCHLIST)) {
          const candles = await fetchCandles(instId, bar, BB_PERIOD + VOL_LOOKBACK + 2);
          if (candles.length < BB_PERIOD) continue;

          const currClose = candles[candles.length - 1]!.close;
          const closes = candles.map((c) => c.close);
          const boll = computeBollLocal(closes);
          if (!boll) continue;

          const { upper, middle, lower } = boll;
          if (middle <= 0) continue;

          const bandwidth = ((upper - lower) / middle) * 100;
          const volOk = volumeConfirmed(candles);

          if (currClose > upper) {
            const pctAbove = ((currClose - upper) / upper) * 100;
            const alertKey = `bb_upper_${name}_${tfKey}`;
            if (state.canAlert(alertKey, tfCooldown)) {
              const severity = tfKey === "4H" ? "warning" : "info";
              alerts.push(createAlert({
                rule: "布林突破",
                severity,
                title: `${name} 突破布林上轨（${tfLabel}）`,
                detail: [
                  `收盘价: $${currClose.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                  `上轨: $${upper.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                  `中轨: $${middle.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                  `下轨: $${lower.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                  `带宽: ${bandwidth.toFixed(2)}%`,
                  `偏离上轨: +${pctAbove.toFixed(2)}%`,
                  `周期: ${tfLabel} | BB(${BB_PERIOD},${BB_STDDEV})`,
                  `成交量确认: ${volOk ? "yes" : "no"}`,
                  "信号: 超买突破 — 关注回调风险"
                ].join("\n"),
                timestamp: nowDisplay(),
                direction: 0.8,
                strength: Math.min(pctAbove / 5, 1),
                asset: name
              }));
            }
          }

          if (currClose < lower && !bearishSuppress) {
            const pctBelow = ((currClose - lower) / lower) * 100;
            const alertKey = `bb_lower_${name}_${tfKey}`;
            if (state.canAlert(alertKey, tfCooldown)) {
              let volStrong = false;
              if (candles.length >= 3) {
                const recent = candles.slice(0, -1).slice(-VOL_LOOKBACK);
                const avgV = recent.length ? recent.reduce((s, c) => s + c.vol, 0) / recent.length : 0;
                volStrong = avgV > 0 && candles[candles.length - 1]!.vol >= avgV * 0.8;
              }
              const pctBelowBand = Math.abs(pctBelow);
              let severity: "info" | "warning" =
                tfKey === "4H" && volStrong && pctBelowBand >= 1 ? "warning" : "info";
              if (bearishCap && severity !== "info") severity = bearishCap;

              alerts.push(createAlert({
                rule: "布林突破",
                severity,
                title: `${name} 跌破布林下轨（${tfLabel}）`,
                detail: [
                  `收盘价: $${currClose.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                  `上轨: $${upper.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                  `中轨: $${middle.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                  `下轨: $${lower.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                  `带宽: ${bandwidth.toFixed(2)}%`,
                  `偏离下轨: ${pctBelow.toFixed(2)}%`,
                  `周期: ${tfLabel} | BB(${BB_PERIOD},${BB_STDDEV})`,
                  `成交量确认: ${volOk ? "yes" : "no"}`,
                  "信号: 超卖突破 — 关注反弹机会"
                ].join("\n"),
                timestamp: nowDisplay(),
                direction: -0.8,
                strength: Math.min(Math.abs(pctBelow) / 5, 1),
                asset: name
              }));
            }
          }

          if (bandwidth < squeezeThreshold) {
            const alertKey = `bb_squeeze_${name}_${tfKey}`;
            if (state.canAlert(alertKey, tfCooldown)) {
              alerts.push(createAlert({
                rule: "布林收窄",
                severity: "info",
                title: `${name} 布林带收窄（${tfLabel}）`,
                detail: [
                  `收盘价: $${currClose.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                  `上轨: $${upper.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                  `下轨: $${lower.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                  `带宽: ${bandwidth.toFixed(2)}% (阈值: ${squeezeThreshold}%)`,
                  `周期: ${tfLabel} | BB(${BB_PERIOD},${BB_STDDEV})`,
                  "信号: 波动率收缩 — 即将迎来方向性突破"
                ].join("\n"),
                timestamp: nowDisplay(),
                direction: 0,
                strength: 0.3,
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