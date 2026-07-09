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

const LLM_PROMPT = `你是一个加密货币事件交易分析师。以下是最新热点新闻列表。
请评估每条新闻的交易价值，返回 JSON 数组。

评估维度：
1. impact: "high" / "medium" / "low" — 交易价值
2. direction: "bullish" / "bearish" / "neutral" — 对加密市场的方向影响
3. asset: 最相关的资产代码（如 "BTC", "ETH", "SOL", "UNI"），无特定关联写 "CRYPTO"
4. meme_potential: true/false — 该事件是否可能催生 meme 币
5. reason: 一句话说明交易逻辑（中文，25字以内）

只返回 JSON 数组，不要其他文字。格式：
[{"idx": 0, "impact": "high", "direction": "bullish", "asset": "BTC", "meme_potential": false, "reason": "..."}]

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

export function buildPanewsUnclassifiedAlert(art: Record<string, string>): Alert {
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

      const candidates: Array<Record<string, string>> = [];
      for (const art of articles) {
        const title = (art.title ?? "").trim();
        const artId = art.id ?? "";
        if (!title) continue;
        const normTitle = title.toLowerCase().replace(/\s+/g, " ").trim();
        const titleHash = createHash("md5").update(normTitle).digest("hex").slice(0, 12);
        if (!state.canAlert(`panews_${titleHash}`, 86400)) continue;
        if (artId) {
          const idKey = `panews_id_${artId.slice(-12)}`;
          if (!state.canAlert(idKey, 86400)) continue;
        }
        candidates.push(art);
      }
      if (!candidates.length) return alerts;

      const classifications = await llmClassify(candidates);
      const clsMap = new Map<number, Record<string, unknown>>();
      for (const c of classifications) {
        const idx = c.idx;
        if (typeof idx === "number" && idx >= 0 && idx < candidates.length) clsMap.set(idx, c);
      }

      const agentUnavailable = classifications.length === 0 && candidates.length > 0;

      for (let i = 0; i < candidates.length; i++) {
        const art = candidates[i]!;
        const title = (art.title ?? "").trim();
        const desc = (art.desc ?? "").trim();
        const cls = clsMap.get(i);
        if (!cls) {
          if (!agentUnavailable) continue;
          alerts.push(buildPanewsUnclassifiedAlert(art));
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
        if (severity === "warning" && (directionStr === "bullish" || directionStr === "bearish")) {
          const dirSlot = `panews_dir_${assetKey}_${directionStr}`;
          if (!state.canAlert(dirSlot, 7200)) severity = "info";
        }

        const detailParts: string[] = [];
        if (desc) detailParts.push(desc.slice(0, 300));
        if (reason) detailParts.push(`\n💡 交易逻辑: ${reason}`);
        if (memePotential) detailParts.push("🐸 Meme 潜力: 该事件可能催生 meme 币");
        detailParts.push(`📊 影响: ${impact} | 方向: ${directionStr}`);
        if (direction > 0) detailParts.push(`📈 信号: 偏多 (${direction >= 0 ? "+" : ""}${direction.toFixed(1)})`);
        else if (direction < 0) detailParts.push(`📉 信号: 偏空 (${direction.toFixed(1)})`);

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
          }),
        );
      }
      return alerts;
    },
  };
}
