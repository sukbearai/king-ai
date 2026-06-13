import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { nowDisplay, okxGet, okxPost } from "../data-helpers.js";
import { getScratchpad } from "../scratchpad.js";

const MA_WATCHLIST: Record<string, string> = {
  "BTC-USDT": "BTC",
  "ETH-USDT": "ETH",
  "SOL-USDT": "SOL"
};

const MA_PERIODS = [20, 50, 200];

const MA_TIMEFRAMES: Record<string, { bar: string; cooldown: number; label: string }> = {
  "4H": { bar: "4H", cooldown: 14400, label: "4小时" },
  "1Dutc": { bar: "1Dutc", cooldown: 86400, label: "日线" }
};

const MIN_CROSS_DISTANCE_PCT = 0.3;
const VOL_CONFIRM_RATIO: Record<number, number> = { 20: 0.6, 50: 0.5, 200: 0.5 };
const VOL_LOOKBACK = 10;

interface CandleRow {
  close: number;
  vol: number;
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

function breakdownConfirmed(candles: CandleRow[], maVal: number): boolean {
  if (candles.length < 2) return true;
  return candles[candles.length - 1]!.close < maVal && candles[candles.length - 2]!.close < maVal;
}

function volumeConfirmed(candles: CandleRow[], period: number): boolean {
  if (candles.length < 3) return true;
  const recent = candles.slice(0, -1).slice(-VOL_LOOKBACK);
  const currentVol = candles[candles.length - 1]!.vol;
  const avgVol = recent.length ? recent.reduce((s, c) => s + c.vol, 0) / recent.length : 0;
  if (avgVol <= 0) return true;
  const ratio = VOL_CONFIRM_RATIO[period] ?? 0.5;
  return currentVol >= avgVol * ratio;
}

function maSeverity(tf: string, period: number, sym: string, direction: string, bearishCap: string | null): "info" | "warning" {
  let sev: "info" | "warning";
  if (tf === "1Wutc") {
    sev = "warning";
  } else if (tf === "1Dutc") {
    if (sym === "BTC" && period === 20 && direction === "突破") sev = "warning";
    else if (sym === "BTC" && period === 50 && direction === "跌破") sev = "warning";
    else sev = "info";
  } else {
    sev = "info";
  }
  if (direction === "跌破" && bearishCap && sev !== "info") {
    return bearishCap as "info" | "warning";
  }
  return sev;
}

export function createRuleK(): AlertRule {
  return {
    name: "ma_breakdown",
    ruleKey: "k",
    defaultCooldown: 600,
    async check(state: AlertState): Promise<Alert[]> {
      const alerts: Alert[] = [];
      const regime = await getScratchpad().getRegime();
      const bearishSuppress = regime === "risk_on";
      const bearishCap = regime !== "risk_off" && regime !== "risk_on" ? "info" : null;

      for (const [tfKey, tfCfg] of Object.entries(MA_TIMEFRAMES)) {
        const { bar, cooldown: tfCooldown, label: tfLabel } = tfCfg;
        const maAll: Record<string, Array<Record<string, string>>> = {};
        const candlesAll: Record<string, CandleRow[]> = {};

        for (const [instId, name] of Object.entries(MA_WATCHLIST)) {
          const candles = await fetchCandles(instId, bar, VOL_LOOKBACK + 2);
          if (candles.length >= 2) candlesAll[name] = candles;

          const resp = await okxPost("/api/v5/aigc/mcp/indicators", {
            instId,
            timeframes: [bar],
            indicators: {
              MA: { paramList: MA_PERIODS, returnList: true, limit: 2 }
            }
          });

          try {
            const outer = resp.data as Array<{ data?: unknown[] }> | undefined;
            if (!outer?.length) continue;
            const inner = outer[0]!.data as Array<{
              timeframes?: Record<string, { indicators?: { MA?: Array<Record<string, unknown>> } }>;
            }>;
            if (!inner?.length) continue;
            const maRows = inner[0]!.timeframes?.[bar]?.indicators?.MA;
            if (!maRows) continue;

            const parsed: Array<Record<string, string>> = [];
            for (const row of maRows) {
              const vals = (row.values ?? row) as Record<string, string>;
              const entry: Record<string, string> = {};
              for (const p of MA_PERIODS) {
                entry[String(p)] = String(vals[String(p)] ?? "0");
              }
              parsed.push(entry);
            }
            maAll[name] = parsed;
          } catch {
            continue;
          }
        }

        if (!Object.keys(maAll).length) continue;

        for (const [, name] of Object.entries(MA_WATCHLIST)) {
          const candles = candlesAll[name];
          if (!candles || candles.length < 2) continue;

          const currClose = candles[candles.length - 1]!.close;
          const prevClose = candles[candles.length - 2]!.close;
          const maData = maAll[name];
          if (!maData || maData.length < 2) continue;

          const prevMaRow = maData[0]!;
          const currMaRow = maData[1]!;

          const volOkCache: Record<number, boolean> = {};
          for (const p of MA_PERIODS) {
            volOkCache[p] = volumeConfirmed(candles, p);
          }

          for (const period of MA_PERIODS) {
            const pStr = String(period);
            const currMa = Number.parseFloat(currMaRow[pStr] ?? "0");
            const prevMa = Number.parseFloat(prevMaRow[pStr] ?? "0");
            if (!Number.isFinite(currMa) || !Number.isFinite(prevMa) || currMa <= 0 || prevMa <= 0) continue;

            const volOk = volOkCache[period] ?? true;
            const maStrength = { 20: 0.5, 50: 0.7, 200: 1 }[period] ?? 0.5;

            if (prevClose > prevMa && currClose < currMa && !bearishSuppress) {
              if (!volOk) continue;
              if (!breakdownConfirmed(candles, currMa)) continue;

              const pctBelow = ((currClose - currMa) / currMa) * 100;
              if (Math.abs(pctBelow) < MIN_CROSS_DISTANCE_PCT) continue;

              const alertKey = `ma_break_${name}_${tfKey}_${period}`;
              if (state.canAlert(alertKey, tfCooldown)) {
                alerts.push(createAlert({
                  rule: "均线跌破",
                  severity: maSeverity(tfKey, period, name, "跌破", bearishCap),
                  title: `${name} 跌破 MA${period}（${tfLabel}）`,
                  detail: [
                    `收盘价: $${currClose.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                    `MA${period}: $${currMa.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                    `周期: ${tfLabel}`,
                    `偏离: ${pctBelow >= 0 ? "+" : ""}${pctBelow.toFixed(2)}%`,
                    "成交量确认: ✓ | 双K线确认: ✓",
                    "信号: 趋势反转确认"
                  ].join("\n"),
                  timestamp: nowDisplay(),
                  direction: -1,
                  strength: maStrength,
                  asset: name
                }));
              }
            }

            if (prevClose < prevMa && currClose > currMa) {
              if (!volOk) continue;

              const pctAbove = ((currClose - currMa) / currMa) * 100;
              if (Math.abs(pctAbove) < MIN_CROSS_DISTANCE_PCT) continue;

              const alertKey = `ma_recov_${name}_${tfKey}_${period}`;
              if (state.canAlert(alertKey, tfCooldown)) {
                alerts.push(createAlert({
                  rule: "均线突破",
                  severity: maSeverity(tfKey, period, name, "突破", bearishCap),
                  title: `${name} 站上 MA${period}（${tfLabel}）`,
                  detail: [
                    `收盘价: $${currClose.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                    `MA${period}: $${currMa.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                    `周期: ${tfLabel}`,
                    `偏离: +${pctAbove.toFixed(2)}%`,
                    "成交量确认: ✓",
                    "信号: 上升趋势确认"
                  ].join("\n"),
                  timestamp: nowDisplay(),
                  direction: 1,
                  strength: maStrength,
                  asset: name
                }));
              }
            }
          }
        }
      }

      return alerts;
    }
  };
}