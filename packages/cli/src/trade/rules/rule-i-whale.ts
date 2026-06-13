import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { dotGet, loadTradeConfig } from "../config.js";
import { gmgnMarketTrending, gmgnTokenUrl, gmgnWalletUrl, nowDisplay, runOnchainos } from "../data-helpers.js";

const CHAIN_MAP: Record<string, string> = {
  solana: "sol",
  bsc: "bsc",
  ethereum: "eth",
  base: "base"
};

const QUOTE_PRICES: Record<string, number> = {
  SOLANA: 85,
  SOL: 85,
  BNB: 600,
  ETH: 2400,
  USDT: 1,
  USDC: 1
};

interface TokenBuyGroup {
  wallets: Set<string>;
  totalAmount: number;
  mcap: number;
  symbol: string;
  tokenAddr: string;
  chain: string;
}

function gmgnRiskCheck(
  gmgnIndex: Map<string, Record<string, unknown>>,
  symbol: string
): [string, number] {
  const gmgn = gmgnIndex.get(symbol.toUpperCase());
  if (!gmgn) return ["", 0];

  const parts: string[] = [];
  let strMod = 0;

  const smCount = Number(gmgn.smart_degen_count ?? 0) || 0;
  const kolCount = Number(gmgn.renowned_count ?? 0) || 0;
  const ratRate = Number(gmgn.rat_trader_amount_rate ?? 0) || 0;
  const bundler = Number(gmgn.bundler_rate ?? 0) || 0;
  const honeypot = gmgn.is_honeypot;
  const wash = Boolean(gmgn.is_wash_trading);

  if (smCount > 0 || kolCount > 0) {
    parts.push(`聪明钱 ${smCount} | KOL ${kolCount}`);
    strMod += 0.1;
  }

  const risks: string[] = [];
  if (honeypot) {
    risks.push("⚠️貔貅");
    strMod -= 0.5;
  }
  if (wash) {
    risks.push("⚠️对倒");
    strMod -= 0.3;
  }
  if (ratRate > 0.05) {
    risks.push(`老鼠仓 ${(ratRate * 100).toFixed(0)}%`);
    strMod -= 0.2;
  }
  if (bundler > 0.3) {
    risks.push(`捆绑 ${(bundler * 100).toFixed(0)}%`);
    strMod -= 0.1;
  }

  if (risks.length) parts.push(risks.join(" | "));

  return [parts.join("\n"), strMod];
}

async function buildGmgnIndex(chains: string[]): Promise<Map<string, Record<string, unknown>>> {
  const index = new Map<string, Record<string, unknown>>();
  for (const chain of chains) {
    const gmgnChain = CHAIN_MAP[chain] ?? chain;
    const tokens = await gmgnMarketTrending(gmgnChain, "1h", 50);
    for (const t of tokens) {
      const sym = String(t.symbol ?? "").toUpperCase();
      if (sym) index.set(sym, t);
    }
  }
  return index;
}

function parseActivities(data: unknown, chain: string): Array<Record<string, unknown>> {
  const activities: Array<Record<string, unknown>> = [];
  const rawActs = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? ((data as Record<string, unknown>).trades as unknown[]) ?? []
      : [];

  for (const act of rawActs) {
    if (act && typeof act === "object") {
      activities.push({ ...(act as Record<string, unknown>), _chain: chain });
    }
  }
  return activities;
}

export function createRuleI(): AlertRule {
  return {
    name: "whale_transfers",
    ruleKey: "i",
    defaultCooldown: 1800,
    async check(state: AlertState): Promise<Alert[]> {
      const alerts: Alert[] = [];
      const config = await loadTradeConfig();

      const chains = (dotGet(config, "data_sources.smart_money.chains", ["solana", "bsc"]) as string[]) ?? [
        "solana",
        "bsc"
      ];
      const walletType = String(dotGet(config, "data_sources.smart_money.wallet_type", 1));
      const trackerType = walletType === "1" ? "smart_money" : walletType;

      const whaleCfg = (dotGet(config, "alerts.whale", {}) ?? {}) as Record<string, unknown>;
      const whaleMinMcap = Number(whaleCfg.min_mcap ?? 5_000);
      const whaleMinAmount = Number(whaleCfg.min_amount ?? 10_000);

      const gmgnIndex = await buildGmgnIndex(chains);

      const activities: Array<Record<string, unknown>> = [];
      for (const chain of chains) {
        const data = await runOnchainos([
          "market",
          "address-tracker-activities",
          "--tracker-type",
          trackerType,
          "--chain",
          chain
        ]);
        activities.push(...parseActivities(data, chain));
      }

      const tokenBuys = new Map<string, TokenBuyGroup>();

      for (const act of activities) {
        const wallet = String(act.walletAddress ?? act.address ?? "");
        const tradeType = String(act.tradeType ?? act.type ?? "0");
        const action =
          tradeType === "1" ? "buy" : tradeType === "2" ? "sell" : tradeType;
        const symbol = String(act.tokenSymbol ?? act.symbol ?? "?");
        const tokenAddr = String(act.tokenContractAddress ?? "");
        const chain = String(act._chain ?? "?");

        const quoteSym = String(act.quoteTokenSymbol ?? "").toUpperCase();
        const quotePrice = QUOTE_PRICES[quoteSym] ?? 1;
        const amountRaw = Number.parseFloat(String(act.quoteTokenAmount ?? "0")) || 0;
        const amount = amountRaw * quotePrice;
        const mcap = Number.parseFloat(String(act.marketCap ?? "0")) || 0;

        if (amount < whaleMinAmount) continue;
        if (mcap > 0 && mcap < whaleMinMcap) continue;
        if (mcap < 200_000 && action !== "buy") continue;

        if (action === "buy") {
          const tokenKey = tokenAddr ? `${chain}_${tokenAddr}` : `${chain}_${symbol}`;
          let grp = tokenBuys.get(tokenKey);
          if (!grp) {
            grp = {
              wallets: new Set(),
              totalAmount: 0,
              mcap,
              symbol,
              tokenAddr,
              chain
            };
            tokenBuys.set(tokenKey, grp);
          }
          grp.wallets.add(wallet);
          grp.totalAmount += amount;
          if (mcap > grp.mcap) grp.mcap = mcap;
        }
      }

      for (const [, grp] of tokenBuys) {
        const walletCount = grp.wallets.size;
        const { symbol, tokenAddr, chain, mcap, totalAmount } = grp;

        const mcapDisplay =
          mcap > 0
            ? mcap >= 1_000_000
              ? `$${(mcap / 1_000_000).toFixed(1)}M`
              : mcap >= 1000
                ? `$${(mcap / 1000).toFixed(0)}K`
                : `$${mcap.toFixed(0)}`
            : "";

        const amountDisplay =
          totalAmount < 1_000
            ? `$${totalAmount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
            : totalAmount < 1_000_000
              ? `$${(totalAmount / 1000).toFixed(0)}K`
              : `$${(totalAmount / 1_000_000).toFixed(1)}M`;

        const [gmgnText, strMod] = gmgnRiskCheck(gmgnIndex, symbol);

        const reversalZoneStrong = mcap >= 500_000 && mcap < 1_000_000 && walletCount >= 3;
        const reversalZoneSuggestive =
          mcap >= 5_000_000 && mcap < 50_000_000 && walletCount >= 3 && !reversalZoneStrong;

        let severity: "info" | "warning" | "critical";
        if (reversalZoneStrong) severity = "warning";
        else if (reversalZoneSuggestive) severity = "info";
        else severity = "info";

        if (strMod <= -0.3) severity = "info";

        const alertKey = tokenAddr ? `whale_${chain}_${tokenAddr}` : `whale_${chain}_${symbol}`;
        if (!state.canAlert(alertKey, 3600)) continue;

        const walletLines: string[] = [];
        for (const w of [...grp.wallets].sort()) {
          const wurl = gmgnWalletUrl(chain, w);
          walletLines.push(wurl ? `  ${w}\n  🔗 ${wurl}` : `  ${w}`);
        }

        const detailParts = [
          `🐳 ${walletCount}个大户同时买入`,
          `钱包:\n${walletLines.join("\n")}`,
          `总金额: ${amountDisplay}`
        ];
        if (mcapDisplay) detailParts.push(`市值: ${mcapDisplay}`);
        detailParts.push(`链: ${chain}`);
        if (tokenAddr) {
          detailParts.push(`合约: ${tokenAddr}`);
          const gurl = gmgnTokenUrl(chain, tokenAddr);
          if (gurl) detailParts.push(`📈 ${gurl}`);
        }
        if (gmgnText) detailParts.push(gmgnText);

        let whaleStrength = 0.4 + 0.2 * Math.min(walletCount, 5);
        if (mcap >= 1_000_000) whaleStrength += 0.2;
        whaleStrength = Math.max(0.1, Math.min(1.5, whaleStrength + strMod));

        let direction: number;
        let titlePrefix: string;
        let tags: string[];

        if (reversalZoneStrong) {
          direction = -0.9;
          titlePrefix = `⚠️ 疑似派发 ${walletCount}鲸鱼买入`;
          detailParts.push(
            "📉 历史回测(n=16, CI下界72%): 此mcap区间大户买入 88% 后续下跌, avg -42%\n" +
              "💡 Playbook: 涨50%即止盈做空 / 跌30%硬止损; 24h 持有 hit 34% avg -6.8% (fat tail min -99.9% max +666%)"
          );
          tags = ["whale_distribution_risk", "regime_gated"];
          whaleStrength = Math.min(whaleStrength + 0.3, 1.5);
        } else if (reversalZoneSuggestive) {
          direction = -0.5;
          titlePrefix = `🔍 大户活动 ${walletCount}鲸鱼买入`;
          detailParts.push("📊 历史偏弱反指(n≤8, 样本不稳): 此mcap区间大户买入常 -7%~-18% 后续");
          tags = ["whale_distribution_risk"];
        } else {
          direction = 0.3;
          titlePrefix = `🐳 ${walletCount}鲸鱼同买`;
          tags = [];
        }

        const chainFull =
          { solana: "solana", bsc: "bsc", ethereum: "ethereum", base: "base" }[chain] ?? chain;

        alerts.push(
          createAlert({
            rule: "大户转账",
            severity,
            title: `${titlePrefix} ${symbol} ${amountDisplay} ${mcapDisplay}`.trim(),
            detail: detailParts.join("\n"),
            timestamp: nowDisplay(),
            direction,
            strength: whaleStrength,
            asset: symbol,
            tokenContract: tokenAddr,
            tokenChain: chainFull,
            tokenMcap: mcap,
            tags
          })
        );
      }

      return alerts;
    }
  };
}