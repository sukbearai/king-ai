import { createHash } from "node:crypto";
import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { nowDisplay, runTg } from "../data-helpers.js";

export function parseMemeTradeAmount(amtStr: string): number {
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

function chainFmUrl(chain: string, address: string): string {
  return `https://chain.fm/token/${chain}/${address}`;
}

export function createRuleE(minUsd = 1500): AlertRule {
  return {
    name: "meme_large_buys",
    ruleKey: "e",
    defaultCooldown: 600,
    async check(state: AlertState): Promise<Alert[]> {
      const alerts: Alert[] = [];

      await runTg(["sync", "meme链上监控"], 60_000);
      const recent = await runTg(["recent", "--hours", "1", "-n", "20", "-c", "meme", "--yaml"], 30_000);
      if (!recent.ok) return alerts;

      for (const line of recent.data.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length < 10) continue;
        if (!/\bbought\b|\bbuy\b|\bswap\b|\bsold\b|\bsell\b/i.test(trimmed)) continue;

        const tradeValMatch = trimmed.match(/with\s+[\d.]+\s+\[?\w+\]?(?:\([^)]*\))?\s*\(\$?([\d,]+\.?\d*[KMkm]?)\)/i);
        const amounts = tradeValMatch
          ? [tradeValMatch[1]!]
          : [...trimmed.matchAll(/(?<!MC:)(?<!P:)\$(\d[\d,]*\.?\d*[KMkm]?)/g)].map((m) => m[1]!);

        for (const amtStr of amounts) {
          try {
            const amount = parseMemeTradeAmount(amtStr);
            if (amount < minUsd) continue;
            const contentHash = createHash("md5").update(trimmed).digest("hex").slice(0, 10);
            if (!state.canAlert(`meme_large_${contentHash}`, 3600)) continue;

            const detailParts = [trimmed.slice(0, 500)];
            const tokenMatch =
              trimmed.match(/\[([A-Za-z][A-Za-z0-9_]{1,15})\]\(https?:\/\/chain\.fm\/token\//) ??
              trimmed.match(/(?:bought|buy|sold|sell|swap)\s+\$?([A-Za-z][A-Za-z0-9_]{1,15})/i) ??
              trimmed.match(/\$([A-Za-z][A-Za-z0-9_]{1,15})/);
            const chainFm = trimmed.match(/chain\.fm\/token\/(\w+)\/([0-9a-zA-Z]+)/);
            const chainMap: Record<string, string> = {
              solana: "solana",
              sol: "solana",
              bsc: "bsc",
              ethereum: "ethereum",
              eth: "ethereum",
              base: "base",
            };

            let tokenChain = "";
            let tokenContract = "";
            if (chainFm) {
              const chainRaw = chainFm[1]!.toLowerCase();
              tokenContract = chainFm[2]!;
              tokenChain = chainMap[chainRaw] ?? chainRaw;
              detailParts.push(`\n📋 ${tokenContract}\n🔗 ${chainFmUrl(chainRaw, tokenContract)}`);
            }

            const severity: Alert["severity"] = amount >= 5000 ? "critical" : "warning";
            alerts.push(
              createAlert({
                rule: "Meme 大额",
                severity,
                title: `链上大额交易 $${amount.toLocaleString()}`,
                detail: detailParts.join("\n"),
                timestamp: nowDisplay(),
                direction: -0.7,
                strength: Math.min(amount / 5000, 1),
                asset: tokenMatch?.[1] ?? "",
                tokenContract,
                tokenChain,
                tokenMcap: 0,
                tags: ["meme_distribution_risk"],
              }),
            );
          } catch {}
        }
      }
      return alerts;
    },
  };
}
