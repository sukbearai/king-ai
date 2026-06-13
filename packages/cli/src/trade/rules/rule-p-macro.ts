import { createHash } from "node:crypto";
import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { nowDisplay } from "../data-helpers.js";

const BLOOMBERG_ECONOMICS_RSS = "https://feeds.bloomberg.com/economics/news.rss";

const TIER1_KW = new Set([
  "crypto", "bitcoin", "stablecoin", "sec", "regulation",
  "fomc", "fed ", "federal reserve", "quantitative"
]);

const TIER2_KW = new Set([
  "cpi", "tariff", "trade war", "gdp", "treasury", "yields",
  "dollar", "recession", "sanctions", "opec", "oil",
  "hormuz", "strait", "inflation"
]);

const MAJOR_ECONOMIES = new Set([
  "us", "u.s.", "united states", "america", "china", "eu", "europe",
  "japan", "uk", "britain", "fed", "ecb", "boj", "pboc",
  "global", "world", "g7", "g20", "middle east", "iran", "israel",
  "russia", "india", "opec"
]);

const NOISE_COUNTRIES = new Set([
  "new zealand", "rbnz", "poland", "hungary", "czech", "romania",
  "venezuela", "colombia", "peru", "chile", "kenya", "nigeria",
  "sri lanka", "bangladesh", "pakistan", "philippines"
]);

const BEARISH_KW = new Set(["tariff", "trade war", "sanctions", "oil", "opec", "cpi", "inflation", "recession"]);
const HAWKISH_KW = new Set(["fomc", "fed ", "federal reserve", "quantitative"]);

function normalizeTitle(title: string): string {
  const t = title.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
  return t.split(/\s+/).slice(0, 8).join(" ");
}

function findKeywords(text: string, keywords: Set<string>): Set<string> {
  const lower = text.toLowerCase();
  const matches = new Set<string>();
  for (const kw of keywords) {
    const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(lower)) matches.add(kw);
  }
  return matches;
}

function hasMajorEconomy(text: string): boolean {
  const lower = text.toLowerCase();
  for (const e of MAJOR_ECONOMIES) {
    const re = new RegExp(`\\b${e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(lower)) return true;
  }
  return false;
}

function hasNoiseCountry(text: string): boolean {
  const lower = text.toLowerCase();
  for (const n of NOISE_COUNTRIES) {
    const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(lower)) return true;
  }
  return false;
}

interface RssItem {
  title: string;
  summary: string;
  link: string;
}

function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1] ?? "";
    const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1] ?? "").trim();
    const summary = (block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i)?.[1] ?? "").trim();
    const link = (block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ?? "").trim();
    if (title) items.push({ title, summary, link });
  }
  return items;
}

async function fetchBloombergEconomics(limit = 10): Promise<RssItem[]> {
  try {
    const res = await fetch(BLOOMBERG_ECONOMICS_RSS, {
      headers: { "User-Agent": "king-ai/1.0" },
      signal: AbortSignal.timeout(30_000)
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRssItems(xml).slice(0, limit);
  } catch {
    return [];
  }
}

export function createRuleP(): AlertRule {
  return {
    name: "macro_news",
    ruleKey: "p",
    defaultCooldown: 86400,
    async check(state: AlertState): Promise<Alert[]> {
      const alerts: Alert[] = [];
      const rows = await fetchBloombergEconomics(10);
      if (!rows.length) return alerts;

      for (const row of rows) {
        const { title, summary, link } = row;
        if (!title) continue;
        const text = `${title} ${summary}`;
        const t1Matches = findKeywords(text, TIER1_KW);
        const isNoise = hasNoiseCountry(text);
        if (isNoise && !t1Matches.size) continue;

        const t2Matches = !isNoise && hasMajorEconomy(text) ? findKeywords(text, TIER2_KW) : new Set<string>();
        const allMatches = new Set([...t1Matches, ...t2Matches]);
        if (!allMatches.size) continue;

        const normHash = createHash("md5").update(normalizeTitle(title)).digest("hex").slice(0, 12);
        if (!state.canAlert(`macro_${normHash}`, 86400)) continue;
        if (link) {
          const urlHash = createHash("md5").update(link).digest("hex").slice(0, 12);
          if (!state.canAlert(`macro_url_${urlHash}`, 86400)) continue;
        }

        const kwLabel = [...allMatches].sort().join(", ");
        const severity: Alert["severity"] = t1Matches.size ? "warning" : "info";
        let impact = "";
        if ([...allMatches].some((k) => ["fed rate", "fomc", "fed funds"].includes(k))) {
          impact = "\n💡 影响: Fed 政策直接影响 BTC/ETH 价格走势和稳定币流动性";
        } else if ([...allMatches].some((k) => ["tariff", "trade war", "sanctions"].includes(k))) {
          impact = "\n💡 影响: 地缘/贸易冲突推高避险情绪，关注 BTC 和黄金联动";
        } else if (allMatches.has("oil") || allMatches.has("opec")) {
          impact = "\n💡 影响: 油价波动影响通胀预期，间接影响 Fed 政策路径";
        } else if (allMatches.has("cpi") || allMatches.has("inflation")) {
          impact = "\n💡 影响: 通胀数据决定 Fed 加息/降息节奏，直接影响风险资产";
        }

        const detailParts: string[] = [];
        if (summary) detailParts.push(summary.slice(0, 200));
        if (impact) detailParts.push(impact);
        if (link) detailParts.push(link);

        let macroDir = 0;
        if ([...allMatches].some((k) => BEARISH_KW.has(k))) macroDir = -0.5;
        else if ([...allMatches].some((k) => HAWKISH_KW.has(k))) macroDir = -0.3;

        alerts.push(createAlert({
          rule: "宏观经济",
          severity,
          title: `[${kwLabel}] ${title}`,
          detail: detailParts.join("\n"),
          timestamp: nowDisplay(),
          direction: macroDir,
          strength: t1Matches.size ? 0.6 : 0.4,
          asset: "MACRO"
        }));
      }
      return alerts;
    }
  };
}