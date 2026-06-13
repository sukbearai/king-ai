import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { nowDisplay, runOnchainos } from "../data-helpers.js";

const CHAIN_CONFIGS = {
  ETH: {
    chainArg: "1",
    unit: "Gwei",
    divisor: 1e9,
    absThreshold: 50,
    minFloor: 5,
    spikeMult: 2,
    criticalMult: 5
  },
  SOL: {
    chainArg: "501",
    unit: "Lamports",
    divisor: 1,
    absThreshold: 50_000,
    minFloor: 5_000,
    spikeMult: 2,
    criticalMult: 5
  },
  BSC: {
    chainArg: "56",
    unit: "Gwei",
    divisor: 1e9,
    absThreshold: 15,
    minFloor: 3,
    spikeMult: 2,
    criticalMult: 5
  }
} as const;

const ROLLING_WINDOW = 10;

type ChainKey = keyof typeof CHAIN_CONFIGS;

function extractGasPrice(data: unknown): number | null {
  const items = Array.isArray(data) ? data : data && typeof data === "object" ? [data] : [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    const eip1559 = obj.eip1559Protocol;
    if (eip1559 && typeof eip1559 === "object") {
      const eip = eip1559 as Record<string, unknown>;
      const baseFee = eip.baseFee ?? eip.suggestBaseFee;
      if (baseFee != null) {
        const val = Number.parseFloat(String(baseFee));
        if (Number.isFinite(val)) return val;
      }
    }

    for (const field of ["baseFee", "gasPrice", "suggestBaseFee", "priorityFee"]) {
      const val = obj[field];
      if (val != null) {
        const parsed = Number.parseFloat(String(val));
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }

  return null;
}

export function createRuleO(): AlertRule {
  const history: Record<ChainKey, number[]> = {
    ETH: [],
    SOL: [],
    BSC: []
  };

  return {
    name: "gas_spike",
    ruleKey: "o",
    defaultCooldown: 1800,
    async check(state: AlertState): Promise<Alert[]> {
      const alerts: Alert[] = [];

      for (const chain of Object.keys(CHAIN_CONFIGS) as ChainKey[]) {
        const cfg = CHAIN_CONFIGS[chain];
        const data = await runOnchainos(["gateway", "gas", "--chain", cfg.chainArg]);
        if (!data) continue;

        const rawPrice = extractGasPrice(data);
        if (rawPrice == null) continue;

        const current = rawPrice / cfg.divisor;
        const chainHistory = history[chain];

        const avg = chainHistory.length ? chainHistory.reduce((a, b) => a + b, 0) / chainHistory.length : 0;
        chainHistory.push(current);
        if (chainHistory.length > ROLLING_WINDOW) chainHistory.shift();

        if (chainHistory.length < 3) continue;

        const multiplier = avg > 0 ? current / avg : 0;
        const isSpike = multiplier >= cfg.spikeMult && current >= cfg.minFloor;
        const isAbsHigh = current >= cfg.absThreshold;

        if (!isSpike && !isAbsHigh) continue;

        let severity: "warning" | "critical";
        if (multiplier >= cfg.criticalMult) severity = "critical";
        else if (isSpike || isAbsHigh) severity = "warning";
        else continue;

        const alertKey = `gas_${chain.toLowerCase()}`;
        if (!state.canAlert(alertKey, 1800)) continue;

        const currentFmt = current >= 1000 ? current.toLocaleString("en-US", { maximumFractionDigits: 0 }) : current.toFixed(1);
        const avgFmt = avg >= 1000 ? avg.toLocaleString("en-US", { maximumFractionDigits: 0 }) : avg.toFixed(1);

        const detailLines = [
          `当前 Gas: ${currentFmt} ${cfg.unit}`,
          `滚动均值 (last ${chainHistory.length - 1}): ${avgFmt} ${cfg.unit}`,
          `倍率: ${multiplier.toFixed(1)}x`
        ];
        if (isAbsHigh) {
          detailLines.push(`超过绝对阈值: ${cfg.absThreshold} ${cfg.unit}`);
        }

        alerts.push(
          createAlert({
            rule: "Gas 飙升",
            severity,
            title: `${chain} Gas 飙升 ${currentFmt} ${cfg.unit} (均值 ${avgFmt} ${cfg.unit}, ${multiplier.toFixed(1)}x)`,
            detail: detailLines.join("\n"),
            timestamp: nowDisplay(),
            direction: 0,
            strength: 0.5,
            asset: chain
          })
        );
      }

      return alerts;
    }
  };
}