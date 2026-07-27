import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TRADE_PANEWS_CLI_PATH } from "../../paths.js";
import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { nowDisplay } from "../data-helpers.js";
import { extractJsonFromText, runAgent } from "../llm-utils.js";

const execFileP = promisify(execFile);

function panewsCliPath(): string {
  return TRADE_PANEWS_CLI_PATH;
}

const LLM_PROMPT = `你是加密事件交易分析师。对每条新闻做可交易性判断，返回 JSON 数组。

评估维度：
1. impact: "high" / "medium" / "low"
   - high：明确的供给冲击、安全事件、交易所/稳定币风险、ETF 大额流向、监管落地、解锁进 CEX 等，短线可能改变定价
   - medium：有标的但间接（上币、合作、宏观二手解读）
   - low：观点文、弱关联叙事、事后技术新闻、纯 AI/科技八卦且难映射到具体币
2. direction: "bullish" / "bearish" / "neutral"
   - 黑客/被盗/合约漏洞/交易所关停/提现异常/大额解锁进所 → 默认 bearish
   - 含糊利好（合作、愿景、分析师喊单）→ 倾向 neutral 或 medium+谨慎 bullish，勿轻易 high+bullish
   - risk-off 宏观（加息、油价、风险偏好收缩）对 BTC/山寨 → bearish 或 neutral，勿映射成强多
3. asset: 最相关代码（BTC/ETH/SOL/具体代币）。仅当确实无单一标的时用 "CRYPTO"；能点名就不要写 CRYPTO
4. meme_potential: true/false — 是否可能催生 meme
5. reason: 一句中文交易含义（≤28字），写「为什么要紧 + 怎么看」，不要空话

只返回 JSON 数组：
[{"idx": 0, "impact": "high", "direction": "bearish", "asset": "BTC", "meme_potential": false, "reason": "..."}]

新闻列表：
`;

async function runPanews(args: string[]): Promise<Array<Record<string, string>>> {
  try {
    const { stdout } = await execFileP("node", [panewsCliPath(), ...args], {
      timeout: 30_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const articles: Array<Record<string, string>> = [];
    let current: Record<string, string> = {};
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^\d+\.\s+\*\*/.test(trimmed)) {
        if (Object.keys(current).length) articles.push(current);
        current = {};
      }
      const m = trimmed.match(/^\*\*(\w+)\*\*:\s*(.*)/) ?? trimmed.match(/^\d+\.\s+\*\*(\w+)\*\*:\s*(.*)/);
      if (m) current[m[1]!] = m[2]!.trim();
    }
    if (Object.keys(current).length) articles.push(current);
    return articles;
  } catch {
    return [];
  }
}

export function buildPanewsUnclassifiedAlert(art: Record<string, string>, cooldownKey?: string): Alert {
  const title = (art.title ?? "").trim();
  const desc = (art.desc ?? "").trim();
  return createAlert({
    ruleId: "panews",
    severity: "info",
    title,
    detail: desc ? desc.slice(0, 300) : "（agent 分类暂不可用，仅推送标题）",
    timestamp: nowDisplay(),
    direction: 0,
    strength: 0.3,
    asset: "CRYPTO",
    cooldownKey,
  });
}

async function llmClassify(candidates: Array<Record<string, string>>): Promise<Array<Record<string, unknown>>> {
  if (!candidates.length) return [];
  const lines = candidates.map((art, i) => `[${i}] ${art.title ?? ""}\n    ${(art.desc ?? "").slice(0, 200)}`);
  const prompt = `${LLM_PROMPT}\n${lines.join("\n")}`;
  const raw = await runAgent(prompt, { timeoutMs: 60_000, task: "summarize" });
  if (!raw) return [];
  if (/rejected|high risk|cannot fulfill/i.test(raw)) return [];
  const parsed = extractJsonFromText(raw);
  return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
}

export function createRuleQ(): AlertRule {
  return {
    name: "panews_event",
    ruleKey: "panews",
    defaultCooldown: 86400,
    async check(state: AlertState): Promise<Alert[]> {
      const alerts: Alert[] = [];
      const articles = await runPanews(["list-articles", "--type", "NEWS", "--take", "15", "--lang", "zh"]);
      if (!articles.length) return alerts;

      const candidates: Array<{ art: Record<string, string>; titleKey: string }> = [];
      for (const art of articles) {
        const title = (art.title ?? "").trim();
        const artId = art.id ?? "";
        if (!title) continue;
        const normTitle = title.toLowerCase().replace(/\s+/g, " ").trim();
        const titleHash = createHash("md5").update(normTitle).digest("hex").slice(0, 12);
        const titleKey = `panews_${titleHash}`;
        if (!state.canAlert(titleKey, 86400)) continue;
        if (artId) {
          const idKey = `panews_id_${artId.slice(-12)}`;
          if (!state.canAlert(idKey, 86400)) continue;
        }
        candidates.push({ art, titleKey });
      }
      if (!candidates.length) return alerts;

      const classifications = await llmClassify(candidates.map((c) => c.art));
      const clsMap = new Map<number, Record<string, unknown>>();
      for (const c of classifications) {
        const idx = c.idx;
        if (typeof idx === "number" && idx >= 0 && idx < candidates.length) clsMap.set(idx, c);
      }

      const agentUnavailable = classifications.length === 0 && candidates.length > 0;

      for (let i = 0; i < candidates.length; i++) {
        const { art, titleKey } = candidates[i]!;
        const title = (art.title ?? "").trim();
        const desc = (art.desc ?? "").trim();
        const cls = clsMap.get(i);
        if (!cls) {
          if (!agentUnavailable) continue;
          alerts.push(buildPanewsUnclassifiedAlert(art, titleKey));
          continue;
        }

        const impact = String(cls.impact ?? "low");
        const directionStr = String(cls.direction ?? "neutral");
        const asset = String(cls.asset ?? "CRYPTO");
        const reason = String(cls.reason ?? "");
        const memePotential = Boolean(cls.meme_potential);
        if (impact === "low" && !memePotential) continue;

        let severity: Alert["severity"] = impact === "high" ? "warning" : "info";
        let direction = 0;
        if (directionStr === "bullish") direction = impact === "high" ? 0.6 : 0.3;
        else if (directionStr === "bearish") direction = impact === "high" ? -0.6 : -0.3;
        const strength = impact === "high" ? 0.8 : 0.5;

        const assetKey = asset.toUpperCase() || "CRYPTO";
        // dirSlot only demotes severity; not a 1:1 guard→emit — do not put on cooldownKey.
        if (severity === "warning" && (directionStr === "bullish" || directionStr === "bearish")) {
          const dirSlot = `panews_dir_${assetKey}_${directionStr}`;
          if (!state.canAlert(dirSlot, 7200)) severity = "info";
        }

        const detailParts: string[] = [];
        if (desc) detailParts.push(desc.slice(0, 300));
        if (reason) detailParts.push(`要点: ${reason}`);
        const bias = directionStr === "bullish" ? "偏多" : directionStr === "bearish" ? "偏空" : "中性";
        detailParts.push(`判断: ${bias} · 影响 ${impact}${memePotential ? " · 或有 meme 题材" : ""}`);

        alerts.push(
          createAlert({
            ruleId: "panews",
            severity,
            title,
            detail: detailParts.join("\n"),
            timestamp: nowDisplay(),
            direction,
            strength,
            asset: assetKey,
            cooldownKey: titleKey,
          }),
        );
      }
      return alerts;
    },
  };
}
