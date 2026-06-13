import { createHash } from "node:crypto";
import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import {
  gmgnMarketTrenches,
  gmgnTokenSecurity,
  gmgnTokenUrl,
  nowDisplay,
  runLast30days,
  runOnchainos,
  runTg
} from "../data-helpers.js";

const SUSPICIOUS_PLATFORMS = new Set(["fourmeme_agent", "fourmeme"]);

function parseAmount(amtStr: string): number {
  let cleaned = amtStr.replace(/\$/g, "").replace(/,/g, "");
  let multiplier = 1;
  if (/k$/i.test(cleaned)) {
    multiplier = 1000;
    cleaned = cleaned.slice(0, -1);
  } else if (/m$/i.test(cleaned)) {
    multiplier = 1_000_000;
    cleaned = cleaned.slice(0, -1);
  }
  return Number.parseFloat(cleaned) * multiplier;
}

async function enrichMemeToken(tokenName: string): Promise<string> {
  const parts: string[] = [];
  const searchData = await runOnchainos(["token", "search", "--query", tokenName]);
  const tokens = Array.isArray(searchData)
    ? searchData
    : (searchData && typeof searchData === "object" ? (searchData as Record<string, unknown>).tokens : []);
  const tokenList = Array.isArray(tokens) ? tokens : [];
  if (tokenList[0] && typeof tokenList[0] === "object") {
    const top = tokenList[0] as Record<string, unknown>;
    const address = String(top.tokenContractAddress ?? top.tokenAddress ?? "");
    const chainIdx = String(top.chainIndex ?? "");
    const chainMap: Record<string, string> = { "1": "ethereum", "501": "solana", "56": "bsc" };
    const chainName = chainMap[chainIdx] ?? chainIdx;
    if (address && chainName) {
      const priceData = await runOnchainos(["token", "price-info", "--address", address, "--chain", chainName]);
      if (priceData && typeof priceData === "object") {
        const pd = priceData as Record<string, unknown>;
        parts.push(
          `链上: 价格 ${pd.price ?? pd.lastPrice ?? "?"} | MC ${pd.marketCap ?? "?"} | 24h量 ${pd.volume24h ?? pd.volume ?? "?"} | ` +
          `持有人 ${pd.holders ?? "?"} | 流动性 ${pd.liquidity ?? "?"}`
        );
      }
    }
  }

  for (const chain of ["solana", "bsc"]) {
    const hotData = await runOnchainos(["token", "hot-tokens", "--chain", chain, "--time-frame", "4"]);
    const hotList = Array.isArray(hotData)
      ? hotData
      : (hotData && typeof hotData === "object" ? (hotData as Record<string, unknown>).tokens : []);
    const hots = Array.isArray(hotList) ? hotList : [];
    for (let i = 0; i < hots.length; i++) {
      const tok = hots[i];
      if (!tok || typeof tok !== "object") continue;
      const t = tok as Record<string, unknown>;
      const sym = String(t.tokenSymbol ?? t.symbol ?? "").toLowerCase();
      const name = String(t.tokenName ?? t.name ?? "").toLowerCase();
      if (tokenName.toLowerCase().includes(sym) || tokenName.toLowerCase().includes(name) || sym.includes(tokenName.toLowerCase())) {
        parts.push(`热度: trending=是 (#${i + 1} on ${chain})`);
        break;
      }
    }
  }

  const l30d = await runLast30days(`$${tokenName}`, 60_000);
  const xPosts = (l30d.x as unknown[]) ?? ((l30d.items_by_source as Record<string, unknown>)?.x as unknown[]) ?? [];
  if (Array.isArray(xPosts) && xPosts.length) {
    const count = xPosts.length;
    const mentions = count >= 10 ? "🔴高" : count >= 3 ? "🟡中" : "⚪低";
    parts.push(`推特: 热度=${mentions} (${count}条)`);
  }
  return parts.length ? parts.join("\n") : "";
}

async function scanGmgnTrenches(state: AlertState): Promise<Alert[]> {
  const alerts: Alert[] = [];
  for (const chain of ["sol", "bsc"]) {
    const data = await gmgnMarketTrenches(chain, ["new_creation", "completed"], 30);
    for (const [ttype, tokens] of Object.entries(data)) {
      if (!Array.isArray(tokens)) continue;
      for (const tok of tokens) {
        if (!tok || typeof tok !== "object") continue;
        const t = tok as Record<string, unknown>;
        let smCount = Number(t.smart_degen_count ?? 0);
        let kolCount = Number(t.renowned_count ?? 0);
        const launchpad = String(t.launchpad_platform ?? t.launchpad ?? "");
        if (SUSPICIOUS_PLATFORMS.has(launchpad)) {
          smCount = 0;
          kolCount = 0;
        }
        if (kolCount < 3 && smCount < 5) continue;

        const addr = String(t.address ?? "");
        const symbol = String(t.symbol ?? "?");
        const name = String(t.name ?? symbol);
        const mcap = Number(t.market_cap ?? 0);
        const volume = Number(t.volume ?? 0);
        const liq = Number(t.liquidity ?? 0);
        const holders = Number(t.holder_count ?? 0);
        const ratRate = Number(t.rat_trader_amount_rate ?? 0);
        const bundler = Number(t.bundler_rate ?? 0);
        const honeypot = t.is_honeypot;
        const rug = Number(t.rug_ratio ?? 0);
        const wash = Boolean(t.is_wash_trading);
        const top10 = Number(t.top_10_holder_rate ?? 0);
        if (honeypot || rug > 0.5 || wash || ratRate > 0.2) continue;
        if (mcap < 50_000) continue;
        if (!state.canAlert(`meme_gmgn_${addr}`, 86400)) continue;

        const mcapStr = mcap >= 1_000_000 ? `$${(mcap / 1_000_000).toFixed(1)}M` : `$${(mcap / 1000).toFixed(1)}K`;
        const volStr = volume >= 1_000_000 ? `$${(volume / 1_000_000).toFixed(1)}M` : `$${(volume / 1000).toFixed(0)}K`;
        const detailParts = [
          `代币: ${name} (${symbol})`,
          launchpad ? `链: ${chain} | 平台: ${launchpad}` : `链: ${chain}`,
          `市值: ${mcapStr} | 流动性: $${liq.toFixed(0)} | 24h量: ${volStr}`,
          `持有人: ${holders} | 前10集中: ${(top10 * 100).toFixed(0)}%`,
          `聪明钱: ${smCount} | KOL: ${kolCount}`
        ];
        const risks: string[] = [];
        if (ratRate > 0.05) risks.push(`老鼠仓 ${(ratRate * 100).toFixed(0)}%`);
        if (bundler > 0.3) risks.push(`捆绑 ${(bundler * 100).toFixed(0)}%`);
        if (rug > 0) risks.push(`Rug ${(rug * 100).toFixed(0)}%`);
        if (risks.length) detailParts.push(`⚠️ ${risks.join(" | ")}`);
        detailParts.push(`📈 ${gmgnTokenUrl(chain, addr)}`);
        detailParts.push("💡 止盈+100% 止损-30% | 2h内决策, 不要隔夜");

        const hasStrongKol = kolCount >= 5;
        let severity: Alert["severity"] = mcap < 500_000
          ? "info"
          : hasStrongKol && (smCount >= 5 || mcap >= 2_000_000)
            ? "warning"
            : "info";

        if (severity === "warning") {
          let claimed = false;
          for (let slotId = 0; slotId < 2; slotId++) {
            if (state.canAlert(`meme_hour_${chain}_slot${slotId}`, 3600)) {
              claimed = true;
              break;
            }
          }
          if (!claimed) {
            severity = "info";
            detailParts.push(`⏸️ ${chain} 链 1h 内已推 2 条 meme warning, 降级 info`);
          }
        }

        if (severity === "warning") {
          detailParts.push(
            "📉 历史回测(n=93, 30d): KOL 新币高市值段 88% 后续下跌, avg -35% 6h\n" +
            "💡 Playbook: 涨50%即止盈, 跌30%硬止损"
          );
        }

        const gmgnChainFull = { sol: "solana", bsc: "bsc", eth: "ethereum" }[chain] ?? chain;
        alerts.push(createAlert({
          rule: "Meme 新币",
          severity,
          title: `GMGN 新币 ${symbol} — 聪明钱 ${smCount} KOL ${kolCount}`,
          detail: detailParts.join("\n"),
          timestamp: nowDisplay(),
          direction: severity === "warning" ? -0.7 : 0.2,
          strength: Math.min((smCount + kolCount) / 5, 1),
          asset: symbol,
          tokenContract: addr,
          tokenChain: gmgnChainFull,
          tokenMcap: mcap,
          tags: severity === "warning" ? ["meme_distribution_risk"] : []
        }));
        void ttype;
      }
    }
  }
  return alerts;
}

export function createRuleE(minUsd = 1500): AlertRule {
  return {
    name: "meme_large_buys",
    ruleKey: "e",
    defaultCooldown: 600,
    async check(state: AlertState): Promise<Alert[]> {
      const alerts: Alert[] = [];
      alerts.push(...await scanGmgnTrenches(state));

      await runTg(["sync", "meme链上监控"], 60_000);
      const out = await runTg(["recent", "--hours", "1", "-n", "20", "-c", "meme", "--yaml"], 30_000);
      if (!out) return alerts;

      for (const line of out.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length < 10) continue;
        if (!/\bbought\b|\bbuy\b|\bswap\b|\bsold\b|\bsell\b/i.test(trimmed)) continue;

        const tradeValMatch = trimmed.match(/with\s+[\d.]+\s+\[?\w+\]?(?:\([^)]*\))?\s*\(\$?([\d,]+\.?\d*[KMkm]?)\)/i);
        const amounts = tradeValMatch
          ? [tradeValMatch[1]!]
          : [...trimmed.matchAll(/(?<!MC:)(?<!P:)\$(\d[\d,]*\.?\d*[KMkm]?)/g)].map((m) => m[1]!);

        for (const amtStr of amounts) {
          try {
            const amount = parseAmount(amtStr);
            if (amount < minUsd) continue;
            const contentHash = createHash("md5").update(trimmed).digest("hex").slice(0, 10);
            if (!state.canAlert(`meme_large_${contentHash}`, 3600)) continue;

            const detailParts = [trimmed.slice(0, 200)];
            let tokenMatch = trimmed.match(/\[([A-Za-z][A-Za-z0-9_]{1,15})\]\(https?:\/\/chain\.fm\/token\//);
            if (!tokenMatch) tokenMatch = trimmed.match(/(?:bought|buy|sold|sell|swap)\s+\$?([A-Za-z][A-Za-z0-9_]{1,15})/i);
            if (!tokenMatch) tokenMatch = trimmed.match(/\$([A-Za-z][A-Za-z0-9_]{1,15})/);

            const chainFm = trimmed.match(/chain\.fm\/token\/(\w+)\/([0-9a-zA-Z]+)/);
            const gmgnChainMap: Record<string, string> = {
              solana: "sol", sol: "sol", bsc: "bsc", ethereum: "eth", eth: "eth", base: "base", arbitrum: "arb"
            };
            let mcapF = 0;
            let gmgnChain = "";
            if (chainFm) {
              const chainRaw = chainFm[1]!.toLowerCase();
              const tokenAddr = chainFm[2]!;
              gmgnChain = gmgnChainMap[chainRaw] ?? chainRaw;
              detailParts.push(`\n📋 ${tokenAddr}\n📈 ${gmgnTokenUrl(gmgnChain, tokenAddr)}`);

              const onchainosChain = { sol: "solana", bsc: "bsc", eth: "ethereum", base: "base" }[gmgnChain] ?? chainRaw;
              let searchData = await runOnchainos(["token", "search", "--query", tokenAddr, "--chain", onchainosChain]);
              if (searchData && typeof searchData === "object" && !Array.isArray(searchData)) {
                searchData = (searchData as Record<string, unknown>).data ?? (searchData as Record<string, unknown>).tokens;
              }
              if (Array.isArray(searchData) && searchData[0]) {
                const top = searchData[0] as Record<string, unknown>;
                mcapF = Number(top.marketCap ?? 0);
                if (mcapF > 0) {
                  const mcapStr = mcapF >= 1_000_000 ? `$${(mcapF / 1_000_000).toFixed(1)}M` : `$${(mcapF / 1000).toFixed(1)}K`;
                  detailParts.push(`\n💰 市值: ${mcapStr} | 流动性: $${Number(top.liquidity ?? 0)} | 持有人: ${top.holders ?? "?"}`);
                }
              }

              const sec = await gmgnTokenSecurity(gmgnChain, tokenAddr);
              if (sec.is_honeypot || Number(sec.rug_ratio ?? 0) > 0.5 || sec.is_wash_trading) continue;
            }

            if (tokenMatch) {
              const enrichment = await enrichMemeToken(tokenMatch[1]!);
              if (enrichment) detailParts.push(`\n📊 ${tokenMatch[1]} 详情:\n${enrichment}`);
            }

            let severity: Alert["severity"] = mcapF > 0 && mcapF < 200_000
              ? "info"
              : amount >= 5000
                ? "critical"
                : "warning";

            alerts.push(createAlert({
              rule: "Meme 大额",
              severity,
              title: `链上大额交易 $${amount.toLocaleString()}`,
              detail: detailParts.join("\n"),
              timestamp: nowDisplay(),
              direction: severity === "warning" || severity === "critical" ? -0.7 : 0.2,
              strength: Math.min(amount / 5000, 1),
              asset: tokenMatch?.[1] ?? "",
              tokenContract: chainFm?.[2] ?? "",
              tokenChain: chainFm ? ({ sol: "solana", bsc: "bsc", eth: "ethereum", base: "base" }[gmgnChain] ?? "") : "",
              tokenMcap: mcapF,
              tags: severity === "warning" || severity === "critical" ? ["meme_distribution_risk"] : []
            }));
          } catch {
            continue;
          }
        }
      }
      return alerts;
    }
  };
}