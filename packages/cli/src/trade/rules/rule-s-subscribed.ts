import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { dotGet, loadTradeConfig } from "../config.js";
import { gmgnTokenUrl, gmgnWalletUrl, nowDisplay, runOnchainos } from "../data-helpers.js";

const QUOTE_PRICES: Record<string, number> = {
  SOLANA: 85,
  SOL: 85,
  BNB: 600,
  BSC: 600,
  ETH: 2400,
  WETH: 2400,
  USDT: 1,
  USDC: 1,
  DAI: 1
};

function parseActivities(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === "object") {
    const trades = (data as Record<string, unknown>).trades;
    if (Array.isArray(trades)) return trades as Array<Record<string, unknown>>;
  }
  return [];
}

export function createRuleS(): AlertRule {
  return {
    name: "subscribed_wallets",
    ruleKey: "s",
    defaultCooldown: 1800,
    async check(state: AlertState): Promise<Alert[]> {
      const alerts: Alert[] = [];
      const config = await loadTradeConfig();

      const subCfg = (dotGet(config, "data_sources.subscribed_wallets", {}) ?? {}) as Record<string, unknown>;
      const addresses = (subCfg.addresses as unknown[] ?? [])
        .filter((a): a is string => typeof a === "string" && a.trim().length > 0);
      const chains = (subCfg.chains as string[] | undefined) ?? ["ethereum"];
      const minAmount = Number(subCfg.min_amount ?? 1_000);
      const warnMcap = Number(subCfg.warn_mcap ?? 1_000_000);
      const maxAgeSeconds = Number(subCfg.max_age_seconds ?? 7200);

      if (!addresses.length) return alerts;

      const walletStr = addresses.slice(0, 20).join(",");
      const nowMs = Date.now();
      const maxAgeMs = maxAgeSeconds * 1000;

      for (const chain of chains) {
        const data = await runOnchainos([
          "market",
          "address-tracker-activities",
          "--tracker-type",
          "multi_address",
          "--wallet-address",
          walletStr,
          "--chain",
          chain
        ]);

        for (const act of parseActivities(data)) {
          const wallet = String(act.walletAddress ?? act.address ?? "");
          const tradeType = String(act.tradeType ?? act.type ?? "0");
          const actionZh = tradeType === "1" ? "买入" : tradeType === "2" ? "卖出" : "活动";
          const symbol = String(act.tokenSymbol ?? act.symbol ?? "?");
          const tokenAddr = String(act.tokenContractAddress ?? "");

          const quoteSym = String(act.quoteTokenSymbol ?? "").toUpperCase();
          const quotePrice = QUOTE_PRICES[quoteSym] ?? 1;
          const amount = (Number.parseFloat(String(act.quoteTokenAmount ?? "0")) || 0) * quotePrice;
          const mcap = Number.parseFloat(String(act.marketCap ?? 0)) || 0;

          if (amount < minAmount) continue;

          const tradeTsMs = Number.parseFloat(String(act.tradeTime ?? 0)) || 0;
          if (tradeTsMs > 0 && nowMs - tradeTsMs > maxAgeMs) continue;

          const mcapDisplay =
            mcap > 0
              ? mcap >= 1_000_000
                ? `$${(mcap / 1_000_000).toFixed(1)}M`
                : mcap >= 1000
                  ? `$${(mcap / 1000).toFixed(0)}K`
                  : `$${mcap.toFixed(0)}`
              : "?";

          const amountDisplay =
            amount < 1_000
              ? `$${amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
              : amount < 1_000_000
                ? `$${(amount / 1000).toFixed(1)}K`
                : `$${(amount / 1_000_000).toFixed(2)}M`;

          const severity = mcap >= warnMcap ? "warning" : "info";
          const walletShort = wallet.length > 12 ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}` : wallet;

          const txHash = String(act.txHash ?? act.tx_hash ?? "").trim();
          let alertKey: string;
          let dedupCd: number;
          if (txHash) {
            alertKey = `sub_tx_${chain}_${txHash}`;
            dedupCd = 86400 * 7;
          } else {
            alertKey = `sub_${chain}_${wallet}_${tokenAddr || symbol}_${tradeType}_${Math.floor(tradeTsMs / 1000)}`;
            dedupCd = 1800;
          }
          if (!state.canAlert(alertKey, dedupCd)) continue;

          const detailParts = [`📍 订阅地址 ${walletShort}`];
          const walletUrl = gmgnWalletUrl(chain, wallet);
          if (walletUrl) detailParts.push(`🔗 ${walletUrl}`);
          detailParts.push(`${actionZh} ${symbol} ${amountDisplay}`, `市值: ${mcapDisplay}`, `链: ${chain}`);
          if (tokenAddr) {
            detailParts.push(`合约: ${tokenAddr}`);
            const gmgnUrl = gmgnTokenUrl(chain, tokenAddr);
            if (gmgnUrl) detailParts.push(`📈 ${gmgnUrl}`);
          }

          const direction = tradeType === "1" ? 1 : tradeType === "2" ? -1 : 0;
          const strength = mcap >= warnMcap ? 0.6 : 0.3;

          alerts.push(
            createAlert({
              rule: "订阅地址",
              severity,
              title: `📍 ${walletShort} ${actionZh} ${symbol} ${amountDisplay} ${mcapDisplay}`.trim(),
              detail: detailParts.join("\n"),
              timestamp: nowDisplay(),
              direction,
              strength,
              asset: symbol,
              tokenContract: tokenAddr,
              tokenChain: chain,
              tokenMcap: mcap
            })
          );
        }
      }

      return alerts;
    }
  };
}