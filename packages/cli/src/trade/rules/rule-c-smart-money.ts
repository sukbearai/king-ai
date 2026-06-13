import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { dotGet, loadTradeConfig } from "../config.js";
import { gmgnMarketTrending, nowDisplay, runOnchainos } from "../data-helpers.js";

const CHAIN_MAP: Record<string, string> = {
  solana: "sol",
  bsc: "bsc",
  ethereum: "eth",
  base: "base"
};

interface GmgnToken extends Record<string, unknown> {
  address?: string;
  _trending_rank?: number;
}

function gmgnRiskEnrichment(
  gmgnCache: Map<string, GmgnToken>,
  tokenAddr: string
): [string, number] {
  const gmgn = gmgnCache.get(tokenAddr);
  if (!gmgn) return ["", 0];

  const parts: string[] = [];
  let scoreMod = 0;

  const smCount = Number(gmgn.smart_degen_count ?? 0);
  const kolCount = Number(gmgn.renowned_count ?? 0);
  const ratRate = Number(gmgn.rat_trader_amount_rate ?? 0) || 0;
  const bundler = Number(gmgn.bundler_rate ?? 0) || 0;
  const rug = Number(gmgn.rug_ratio ?? 0) || 0;
  const honeypot = gmgn.is_honeypot;
  const top10 = Number(gmgn.top_10_holder_rate ?? 0) || 0;
  const devHold = Number(gmgn.dev_team_hold_rate ?? 0) || 0;
  const wash = Boolean(gmgn.is_wash_trading);

  if (smCount > 0) {
    parts.push(`GMGN聪明钱: ${smCount}`);
    scoreMod += Math.min(smCount, 3);
  }
  if (kolCount > 0) {
    parts.push(`KOL持仓: ${kolCount}`);
    scoreMod += 1;
  }

  const risks: string[] = [];
  if (ratRate > 0.05) {
    risks.push(`老鼠仓 ${(ratRate * 100).toFixed(0)}%`);
    scoreMod -= 2;
  }
  if (bundler > 0.3) {
    risks.push(`捆绑 ${(bundler * 100).toFixed(0)}%`);
    scoreMod -= 1;
  }
  if (rug > 0.3) {
    risks.push(`Rug风险 ${(rug * 100).toFixed(0)}%`);
    scoreMod -= 2;
  }
  if (honeypot) {
    risks.push("⚠️貔貅");
    scoreMod -= 5;
  }
  if (wash) {
    risks.push("⚠️对倒洗盘");
    scoreMod -= 3;
  }
  if (top10 > 0.5) {
    risks.push(`前10集中 ${(top10 * 100).toFixed(0)}%`);
    scoreMod -= 1;
  }
  if (devHold > 0.1) {
    risks.push(`开发者持仓 ${(devHold * 100).toFixed(0)}%`);
    scoreMod -= 1;
  }

  if (risks.length) {
    parts.push(`风险: ${risks.join(" | ")}`);
  }

  const rank = Number(gmgn._trending_rank ?? 0);
  if (rank > 0 && rank <= 50) {
    parts.unshift(`📊 GMGN 1h 热榜 #${rank}`);
    scoreMod += 1;
  }

  return [parts.join("\n"), scoreMod];
}

async function buildGmgnIndex(chains: string[]): Promise<Map<string, GmgnToken>> {
  const cache = new Map<string, GmgnToken>();
  for (const chain of chains) {
    const gmgnChain = CHAIN_MAP[chain] ?? chain;
    const tokens = await gmgnMarketTrending(gmgnChain, "1h", 50);
    tokens.forEach((t, idx) => {
      const addr = String(t.address ?? "");
      if (addr) {
        cache.set(addr, { ...t, _trending_rank: idx + 1 });
      }
    });
  }
  return cache;
}

function parseSignals(data: unknown, chain: string): Array<Record<string, unknown>> {
  const signals: Array<Record<string, unknown>> = [];
  if (Array.isArray(data)) {
    for (const s of data) {
      if (s && typeof s === "object") {
        signals.push({ ...(s as Record<string, unknown>), chain });
      }
    }
  } else if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const items = (obj.signalList ?? obj.signals ?? []) as unknown[];
    for (const s of items) {
      if (s && typeof s === "object") {
        signals.push({ ...(s as Record<string, unknown>), chain });
      }
    }
  }
  return signals;
}

export function createRuleC(): AlertRule {
  const knownKeys = new Set<string>();

  return {
    name: "smart_money_cluster",
    ruleKey: "c",
    defaultCooldown: 1800,
    async check(state: AlertState): Promise<Alert[]> {
      const alerts: Alert[] = [];
      const config = await loadTradeConfig();

      const chains = (dotGet(config, "data_sources.smart_money.chains", ["solana", "bsc"]) as string[]) ?? [
        "solana",
        "bsc"
      ];
      const smCfg = (dotGet(config, "alerts.smart_money", {}) ?? {}) as Record<string, unknown>;
      const minWallets = Number(smCfg.min_wallets ?? 5);
      const minMcap = Number(smCfg.min_mcap ?? 200_000);

      const gmgnCache = await buildGmgnIndex(chains);

      const signals: Array<Record<string, unknown>> = [];
      for (const chain of chains) {
        const data = await runOnchainos(["signal", "list", "--chain", chain, "--wallet-type", "1"]);
        signals.push(...parseSignals(data, chain));
      }

      for (const s of signals) {
        const tokenMeta = s.token;
        if (!tokenMeta || typeof tokenMeta !== "object") continue;

        const meta = tokenMeta as Record<string, unknown>;
        const token = String(meta.tokenAddress ?? "");
        const symbol = String(meta.symbol ?? "?");
        const cnt = Number.parseInt(String(s.triggerWalletCount ?? "0"), 10);
        const mcap = String(meta.marketCapUsd ?? "0");
        const ts = String(s.timestamp ?? "");

        const key = `sm_${token}_${ts}`;
        if (knownKeys.has(key)) continue;
        knownKeys.add(key);

        if (cnt < minWallets) continue;

        const mcapF = Number.parseFloat(mcap) || 0;
        const mcapStr =
          mcapF > 1_000_000 ? `$${(mcapF / 1_000_000).toFixed(1)}M` : `$${(mcapF / 1000).toFixed(0)}K`;

        if (mcapF < minMcap) continue;

        let score = Math.min(cnt - 3, 3);
        if (mcapF >= 1_000_000) score += 2;
        else if (mcapF >= 100_000) score += 1;

        const [gmgnDetail, scoreMod] = gmgnRiskEnrichment(gmgnCache, token);
        score += scoreMod;
        score = Math.max(0, Math.min(score, 5));
        const scoreStr = `${"🟢".repeat(score)} (${score}/5)`;

        let severity: "info" | "warning" | "critical";
        if (cnt >= 10 && mcapF >= 3_000_000) severity = "critical";
        else if (cnt >= 8 && mcapF >= 1_000_000) severity = "warning";
        else if (score >= 4 && mcapF >= 5_000_000) severity = "warning";
        else if (score >= 5 && mcapF >= 2_000_000) severity = "warning";
        else severity = "info";

        if (score < 3) severity = "info";

        const chain = String(s.chain ?? "solana");
        const gmgnChain = CHAIN_MAP[chain] ?? chain;
        const explorer = `https://gmgn.ai/${gmgnChain}/token/${token}`;

        const alertKey = `sm_cluster_${symbol}`;
        if (!state.canAlert(alertKey, 1800)) continue;

        let detail = `市值: ${mcapStr}\n合约: ${token}\n链: ${chain}\n查看: ${explorer}\n质量: ${scoreStr}`;
        if (gmgnDetail) detail += `\n${gmgnDetail}`;

        let smDirection: number;
        let smTags: string[];
        if (severity === "warning" || severity === "critical") {
          detail += "\n📉 历史回测(n=17, 30d): 聪明钱集群买入 76% 后续下跌";
          smDirection = -0.7;
          smTags = ["smart_money_distribution_risk"];
        } else {
          detail += "\n💡 止盈+100% 止损-30% | 2h内决策, 不要隔夜";
          smDirection = 0.2;
          smTags = [];
        }

        alerts.push(
          createAlert({
            rule: "聪明钱",
            severity,
            title: `${symbol} — ${cnt} 个聪明钱钱包买入`,
            detail,
            timestamp: nowDisplay(),
            direction: smDirection,
            strength: score / 5,
            asset: symbol,
            tokenContract: token,
            tokenChain: chain,
            tokenMcap: mcapF,
            tags: smTags
          })
        );
      }

      if (knownKeys.size > 500) {
        const arr = [...knownKeys].slice(-200);
        knownKeys.clear();
        arr.forEach((k) => knownKeys.add(k));
      }

      return alerts;
    }
  };
}