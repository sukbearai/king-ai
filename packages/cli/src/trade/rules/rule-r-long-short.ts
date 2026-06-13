import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { nowDisplay, okxGet } from "../data-helpers.js";

const COINS = ["BTC", "ETH", "SOL"];

const RETAIL_SHORT_THRESH = 0.85;
const WHALE_LONG_THRESH = 1.15;
const RETAIL_LONG_THRESH = 1.3;
const WHALE_SHORT_THRESH = 0.75;
const RETAIL_SHORT_EXTREME = 0.7;
const WHALE_LONG_EXTREME = 1.3;
const RETAIL_LONG_EXTREME = 1.6;
const WHALE_SHORT_EXTREME = 0.6;

export function createRuleR(): AlertRule {
  return {
    name: "long_short_ratio",
    ruleKey: "r",
    defaultCooldown: 3600,
    async check(state: AlertState): Promise<Alert[]> {
      const alerts: Alert[] = [];
      const squeezeCoins: Array<[string, number, number]> = [];
      const trapCoins: Array<[string, number, number]> = [];

      for (const ccy of COINS) {
        const rAll = await okxGet("/api/v5/rubik/stat/contracts/long-short-account-ratio", {
          ccy,
          period: "1H"
        });
        const rTop = await okxGet(
          "/api/v5/rubik/stat/contracts/long-short-account-ratio-contract-top-trader",
          { instId: `${ccy}-USDT-SWAP`, period: "1H" }
        );

        const allData = rAll.data as unknown[] | undefined;
        const topData = rTop.data as unknown[] | undefined;
        if (!allData?.length || !topData?.length) continue;

        const allRow = allData[0];
        const topRow = topData[0];
        if (!Array.isArray(allRow) || !Array.isArray(topRow) || allRow.length < 2 || topRow.length < 2) {
          continue;
        }

        const allRatio = Number.parseFloat(String(allRow[1]));
        const topRatio = Number.parseFloat(String(topRow[1]));
        if (!Number.isFinite(allRatio) || !Number.isFinite(topRatio)) continue;

        if (allRatio < RETAIL_SHORT_THRESH && topRatio > WHALE_LONG_THRESH) {
          squeezeCoins.push([ccy, allRatio, topRatio]);
        }

        if (allRatio > RETAIL_LONG_THRESH && topRatio < WHALE_SHORT_THRESH) {
          trapCoins.push([ccy, allRatio, topRatio]);
        }
      }

      if (squeezeCoins.length) {
        const isExtreme = squeezeCoins.some(
          ([, a, t]) => a < RETAIL_SHORT_EXTREME && t > WHALE_LONG_EXTREME
        );
        const severity = isExtreme ? "critical" : "warning";
        const cooldown = isExtreme ? 1800 : 3600;

        if (state.canAlert("ls_squeeze", cooldown)) {
          const lines = squeezeCoins.map(
            ([c, a, t]) => `  ${c}: 散户多空比 ${a.toFixed(2)} | 大户多空比 ${t.toFixed(2)}`
          );
          const worst = squeezeCoins.reduce((best, cur) =>
            cur[2] - cur[1] > best[2] - best[1] ? cur : best
          );

          alerts.push(
            createAlert({
              rule: "多空比",
              severity,
              title: `轧空信号 — ${squeezeCoins.map(([c]) => c).join(", ")}`,
              detail: `散户偏空 + 大户偏多，空单挤压风险:\n${lines.join("\n")}\n大量空单被迫平仓 → 价格被动推高`,
              timestamp: nowDisplay(),
              direction: isExtreme ? 0.9 : 0.6,
              strength: Math.min((worst[2] - worst[1]) / 1, 1),
              asset: worst[0]
            })
          );
        }
      }

      if (trapCoins.length) {
        const isExtreme = trapCoins.some(
          ([, a, t]) => a > RETAIL_LONG_EXTREME && t < WHALE_SHORT_EXTREME
        );
        const severity = isExtreme ? "critical" : "warning";
        const cooldown = isExtreme ? 1800 : 3600;

        if (state.canAlert("ls_trap", cooldown)) {
          const lines = trapCoins.map(
            ([c, a, t]) => `  ${c}: 散户多空比 ${a.toFixed(2)} | 大户多空比 ${t.toFixed(2)}`
          );
          const worst = trapCoins.reduce((best, cur) => (cur[1] > best[1] ? cur : best));

          alerts.push(
            createAlert({
              rule: "多空比",
              severity,
              title: `多头陷阱 — ${trapCoins.map(([c]) => c).join(", ")}`,
              detail: `散户偏多 + 大户偏空，回调风险:\n${lines.join("\n")}\n散户接盘 + 大户减仓，注意反转`,
              timestamp: nowDisplay(),
              direction: isExtreme ? -0.9 : -0.6,
              strength: Math.min((worst[1] - worst[2]) / 1, 1),
              asset: worst[0]
            })
          );
        }
      }

      return alerts;
    }
  };
}