import type { Alert } from "./alert-rule.js";
import { dotGet, type TradeConfig } from "./config.js";
import { extractJsonFromText, runAgent } from "./llm-utils.js";
import { stripMarkdown } from "./llm-summarize.js";

export interface TradeAlertAdvice {
  text: string;
  source: "llm" | "fallback";
}

/** Loose shape accepted from the model; output is always prose, not a checklist. */
interface AdviceDraft {
  take: string;
  stance?: string;
  watch?: string;
}

const UNSAFE_CERTAINTY = /保证|稳赚|必(?:涨|跌|赚)|梭哈|满仓|all[ -]?in|(?:立即|马上|现在)(?:买入|卖出|建仓|清仓)/i;

const DISCLAIMER = "仅供参考，不构成个性化投资建议。";

function cleanText(value: unknown, maxLength = 420): string {
  const text = stripMarkdown(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function hasUnsafeLanguage(...parts: Array<string | undefined>): boolean {
  return parts.some((part) => part && UNSAFE_CERTAINTY.test(part));
}

function formatAdviceProse(draft: AdviceDraft, heading: string): string {
  const blocks = [heading, draft.take];
  if (draft.stance) blocks.push(draft.stance);
  if (draft.watch) blocks.push(draft.watch);
  blocks.push(DISCLAIMER);
  return blocks.join("\n\n");
}

/**
 * Accept free-form prose, or compact JSON:
 * {"take":"...","stance":"...","watch":"..."}
 * Rejects empty / certainty / buy-sell imperative language.
 */
export function parseTradeAlertAdvice(text: string): AdviceDraft | null {
  const raw = stripMarkdown(String(text ?? "")).trim();
  if (!raw) return null;

  const parsed = extractJsonFromText(raw);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const take = cleanText(obj.take ?? obj.summary ?? obj.advice, 480);
    const stance = cleanText(obj.stance ?? obj.bias ?? "", 280) || undefined;
    const watch = cleanText(obj.watch ?? obj.next ?? "", 280) || undefined;
    if (!take || hasUnsafeLanguage(take, stance, watch)) return null;
    return { take, stance, watch };
  }

  // Free-form: drop a trailing disclaimer the model may have added; keep 2–4 short paragraphs.
  const body = raw.replace(/(?:仅供参考|不构成(?:个性化)?投资建议)[。．.!！]*\s*$/g, "").trim();
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => cleanText(p.replace(/\n+/g, " "), 480))
    .filter(Boolean)
    .slice(0, 4);
  if (!paragraphs.length) return null;
  const joined = paragraphs.join("\n\n");
  if (hasUnsafeLanguage(joined) || joined.length < 24) return null;
  return {
    take: paragraphs[0]!,
    stance: paragraphs[1],
    watch: paragraphs.slice(2).join(" ") || undefined,
  };
}

export function buildTradeAlertAdvicePrompt(alerts: Alert[]): string {
  const facts = alerts.slice(0, 8).map((alert) => ({
    rule_id: alert.ruleId,
    rule: alert.rule,
    severity: alert.severity,
    title: alert.title,
    detail: alert.detail.slice(0, 1600),
    direction: alert.direction,
    strength: alert.strength,
    asset: alert.asset,
    tags: alert.tags,
  }));
  return [
    "你是资深交易员助手。根据下列告警，写一段给真人看的投资备忘，不要写成系统报告或模板。",
    "只使用给定事实，不得编造价格、持仓、新闻或未出现的数字。",
    "口吻：口语、有判断、短而密。像在微信里跟朋友说「现在怎么看、怎么做」，不要「风险行动框架」「可选行动 1/2/3」。",
    "内容优先顺序：",
    "1) 这件事本质是什么、对哪些标的/风险偏好最要紧；",
    "2) 在当前信息下更合理的偏向（偏防守 / 观望 / 谨慎参与），并点出为何；",
    "3) 若要动手，原则性建议（仓位心态、触发条件、何时放弃），不要下具体市价单指令。",
    "禁止：保证收益、必涨必跌、梭哈/满仓、all-in、立即买入/卖出某证券、编造概率。",
    "若只是数据源故障：只写应等待数据恢复，不要给交易方向。",
    "输出严格 JSON（不要 Markdown、不要 JSON 外文字）：",
    '{"take":"2～4 句说清事件与含义","stance":"1～3 句投资倾向与原则性建议","watch":"可选，1～2 句还要盯什么"}',
    "stance 用完整句子，不要「保守/中性/激进」三档列表。",
    "告警事实：",
    JSON.stringify(facts),
  ].join("\n");
}

function primaryAssets(alerts: Alert[]): string {
  const assets = [...new Set(alerts.map((a) => (a.asset || "").trim().toUpperCase()).filter(Boolean))];
  return assets.slice(0, 3).join("、") || "相关标的";
}

export function buildDeterministicTradeAlertAdvice(alerts: Alert[]): TradeAlertAdvice {
  const critical = alerts.some((alert) => alert.severity === "critical");
  const labels = [...new Set(alerts.map((alert) => alert.rule))].slice(0, 3).join("、") || "交易";
  const assets = primaryAssets(alerts);
  const titles = alerts
    .slice(0, 2)
    .map((a) => a.title.trim())
    .filter(Boolean);
  const headline = titles[0] ? `核心事件：${titles[0].slice(0, 80)}。` : `${labels}出现新告警。`;

  const take = critical
    ? `${headline} 级别已到高风险，主要牵动 ${assets}。先当成风险提醒，而不是单边开仓信号。`
    : `${headline} 来源：${labels}；关注 ${assets}。单条告警信息量有限，宜先定性再决定是否动手。`;

  const stance = critical
    ? "倾向先收缩风险：暂缓加仓与加杠杆，核对现有敞口和最坏回撤；若已持仓，优先明确退出条件，而不是借机扩大仓位。"
    : "默认观望或轻仓试错：没有第二确认前不要追涨杀跌；若计划内本就关注该方向，也只按既定规则小步执行，并预留现金缓冲。";

  const watch = "继续看：数据是否新鲜、有无独立来源印证、盘面是否真的跟着叙事走；对不上就放弃这条。";

  return {
    text: formatAdviceProse({ take, stance, watch }, "投资备忘"),
    source: "fallback",
  };
}

export async function generateTradeAlertAdvice(
  alerts: Alert[],
  runner: (prompt: string) => Promise<string> = (prompt) =>
    runAgent(prompt, { task: "alert_advice", timeoutMs: 45_000 }),
): Promise<TradeAlertAdvice> {
  try {
    const parsed = parseTradeAlertAdvice(await runner(buildTradeAlertAdvicePrompt(alerts)));
    if (parsed) return { text: formatAdviceProse(parsed, "投资备忘"), source: "llm" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[alert-advice] LLM fallback: ${message}\n`);
  }
  return buildDeterministicTradeAlertAdvice(alerts);
}

export function tradeAlertAdviceEnabled(config: TradeConfig): boolean {
  return dotGet(config, "alerts.llm_advice", false) === true;
}
