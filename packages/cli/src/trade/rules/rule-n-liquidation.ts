import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { nowDisplay, okxGet } from "../data-helpers.js";

const COINS = [
  { ccy: "BTC", instId: "BTC-USDT-SWAP" },
  { ccy: "ETH", instId: "ETH-USDT-SWAP" },
  { ccy: "SOL", instId: "SOL-USDT-SWAP" }
];

const OI_DROP_WARN = 0.02;
const OI_DROP_CRIT = 0.04;
const PX_MOVE_CONFIRM = 0.015;

export function createRuleN(): AlertRule {
  return {
    name: "liquidation_cascade",
    ruleKey: "n",
    defaultCooldown: 900,
    async check(state: AlertState): Promise<Alert[]> {
      const alerts: Alert[] = [];

      for (const coin of COINS) {
        const { ccy, instId } = coin;
        const resp = await okxGet("/api/v5/rubik/stat/contracts/open-interest-volume", {
          ccy,
          period: "5m"
        });
        const data = resp.data as unknown[] | undefined;
        if (!data?.length) continue;

        const series: Array<[number, number]> = [];
        for (const row of data) {
          if (!Array.isArray(row) || row.length < 2) continue;
          const ts = Number.parseInt(String(row[0]), 10);
          const oi = Number.parseFloat(String(row[1]));
          if (Number.isFinite(ts) && Number.isFinite(oi)) {
            series.push([ts, oi]);
          }
        }
        series.sort((a, b) => a[0] - b[0]);

        if (series.length < 4) continue;

        const [, latestOi] = series[series.length - 1]!;
        const oi10minAgo = series[series.length - 3]![1];
        const oi15minAgo = series[series.length - 4]![1];

        if (oi10minAgo <= 0 || oi15minAgo <= 0) continue;

        const drop10min = (oi10minAgo - latestOi) / oi10minAgo;
        const drop15min = (oi15minAgo - latestOi) / oi15minAgo;

        let severity: "warning" | "critical" | null = null;
        let windowLabel = "";

        if (drop15min >= OI_DROP_CRIT) {
          const pxMove = await fetch1hPriceMove(instId);
          severity = Math.abs(pxMove) >= PX_MOVE_CONFIRM ? "critical" : "warning";
          windowLabel = "15min";
        } else if (drop10min >= OI_DROP_WARN) {
          severity = "warning";
          windowLabel = "10min";
        }

        if (!severity) continue;

        const pxMove1h = await fetch1hPriceMove(instId);
        let side: string;
        let direction: number;
        if (pxMove1h < -0.005) {
          side = "多头";
          direction = 0.3;
        } else if (pxMove1h > 0.005) {
          side = "空头";
          direction = -0.3;
        } else {
          side = "双向";
          direction = 0;
        }

        const dropShown = windowLabel === "15min" ? drop15min : drop10min;
        const key = `liq_${ccy.toLowerCase()}`;
        if (!state.canAlert(key, 900)) continue;

        const markPrice = await fetchPrice(instId);
        const prevOi = windowLabel === "10min" ? oi10minAgo : oi15minAgo;

        alerts.push(createAlert({
          rule: "清算异常",
          severity,
          title: `${ccy} 清算级联 — OI ${windowLabel}下降 ${(dropShown * 100).toFixed(1)}%`,
          detail: [
            `当前 OI: $${(latestOi / 1e6).toFixed(1)}M`,
            `${windowLabel}前 OI: $${(prevOi / 1e6).toFixed(1)}M`,
            `降幅: ${(dropShown * 100).toFixed(2)}%`,
            `当前价格: $${markPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
            `1h 价格变动: ${pxMove1h >= 0 ? "+" : ""}${(pxMove1h * 100).toFixed(2)}%`,
            `推断: ${side}被清算`
          ].join("\n"),
          timestamp: nowDisplay(),
          direction,
          strength: Math.min(dropShown / OI_DROP_CRIT, 1),
          asset: ccy
        }));
      }

      return alerts;
    }
  };
}

async function fetchPrice(instId: string): Promise<number> {
  const resp = await okxGet("/api/v5/market/ticker", { instId });
  const data = resp.data as Array<{ last?: string }> | undefined;
  if (data?.length) {
    const price = Number.parseFloat(data[0]!.last ?? "0");
    if (Number.isFinite(price)) return price;
  }
  return 0;
}

async function fetch1hPriceMove(instId: string): Promise<number> {
  const resp = await okxGet("/api/v5/market/candles", {
    instId,
    bar: "15m",
    limit: "4"
  });
  const candles = resp.data as string[][] | undefined;
  if (!candles?.length) return 0;
  try {
    const firstOpen = Number.parseFloat(candles[candles.length - 1]![1] ?? "0");
    const lastClose = Number.parseFloat(candles[0]![4] ?? "0");
    if (firstOpen > 0 && Number.isFinite(lastClose)) {
      return (lastClose - firstOpen) / firstOpen;
    }
  } catch {
    // ignore
  }
  return 0;
}