import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { dotGet, loadTradeConfig } from "../config.js";
import { gmgnWalletUrl, nowDisplay, runOnchainos, txExplorerUrl } from "../data-helpers.js";

const STABLECOINS: Record<string, Array<[string, string]>> = {
  ethereum: [
    ["USDT", "0xdac17f958d2ee523a2206206994597c13d831ec7"],
    ["USDC", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"]
  ],
  solana: [
    ["USDT", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"],
    ["USDC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]
  ],
  bsc: [
    ["USDT", "0x55d398326f99059ff775485246999027b3197955"],
    ["USDC", "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d"]
  ]
};

const DEFAULT_MIN_USD = 100_000;

function parseTrades(data: unknown, symbol: string, chain: string): Array<Record<string, unknown>> {
  const trades: Array<Record<string, unknown>> = [];
  const rawTrades = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? ((data as Record<string, unknown>).transactionList as unknown[]) ?? []
      : [];

  for (const t of rawTrades) {
    if (t && typeof t === "object") {
      trades.push({ ...(t as Record<string, unknown>), _symbol: symbol, _chain: chain });
    }
  }
  return trades;
}

export function createRuleH(): AlertRule {
  return {
    name: "stablecoin_flows",
    ruleKey: "h",
    defaultCooldown: 1800,
    async check(state: AlertState): Promise<Alert[]> {
      const alerts: Alert[] = [];
      const config = await loadTradeConfig();

      const chains = (dotGet(config, "data_sources.smart_money.chains", ["solana"]) as string[]) ?? ["solana"];
      const minUsd = Number(dotGet(config, "alerts.stablecoin.min_usd", DEFAULT_MIN_USD)) || DEFAULT_MIN_USD;

      const trades: Array<Record<string, unknown>> = [];
      for (const chain of chains) {
        for (const [symbol, address] of STABLECOINS[chain] ?? []) {
          const data = await runOnchainos(["token", "trades", "--address", address, "--chain", chain]);
          trades.push(...parseTrades(data, symbol, chain));
        }
      }

      for (const t of trades) {
        const amountStr = String(t.volume ?? t.amountUsd ?? t.tradeAmountUsd ?? "0");
        const amount = Number.parseFloat(amountStr);
        if (!Number.isFinite(amount)) continue;
        if (amount < minUsd) continue;

        const symbol = String(t._symbol ?? t.symbol ?? "?");
        const chain = String(t._chain ?? t.chain ?? "?");
        const txHash = String(t.txHashUrl ?? t.txHash ?? "");
        const fromAddr = String(t.userAddress ?? t.from ?? "");

        let severity: "info" | "warning" | "critical";
        if (amount >= 500_000) severity = "critical";
        else if (amount >= 100_000) severity = "warning";
        else severity = "info";

        const alertKey = `stable_${symbol}_${chain}_${txHash}`;
        if (!state.canAlert(alertKey, 1800)) continue;

        const amountDisplay =
          amount >= 1_000_000 ? `$${(amount / 1_000_000).toFixed(2)}M` : `$${(amount / 1000).toFixed(0)}K`;

        const detailLines: string[] = [];
        if (fromAddr) {
          let walletLine = `From: ${fromAddr}`;
          const wurl = gmgnWalletUrl(chain, fromAddr);
          if (wurl) walletLine += `\n👛 ${wurl}`;
          detailLines.push(walletLine);
        }
        if (txHash) {
          let txLine = `Tx: ${txHash}`;
          const turl = txExplorerUrl(chain, txHash);
          if (turl) txLine += `\n🔗 ${turl}`;
          detailLines.push(txLine);
        }

        alerts.push(
          createAlert({
            rule: "稳定币大额",
            severity,
            title: `${symbol} 大额 DEX swap ${amountDisplay} (${chain})`,
            detail: detailLines.join("\n"),
            timestamp: nowDisplay(),
            direction: -0.3,
            strength: Math.min(amount / 1_000_000, 1),
            asset: symbol
          })
        );
      }

      return alerts;
    }
  };
}