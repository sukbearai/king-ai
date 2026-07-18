import type { Alert } from "./alert-rule.js";
import { dotGet, type TradeConfig } from "./config.js";
import { extractJsonFromText, runAgent } from "./llm-utils.js";
import { stripMarkdown } from "./llm-summarize.js";

export interface TradeAlertAdvice {
  text: string;
  source: "llm" | "fallback";
}

interface StructuredAdvice {
  summary: string;
  actions: string[];
  avoid: string[];
  checks: string[];
}

const UNSAFE_CERTAINTY = /保证|稳赚|必(?:涨|跌|赚)|梭哈|满仓|all[ -]?in|(?:立即|马上|现在)(?:买入|卖出)/i;

function cleanText(value: unknown, maxLength = 240): string {
  const text = stripMarkdown(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function cleanList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanText(item, 180))
    .map((item) => item.replace(/[。；;]+$/g, ""))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function tradeAlertAdviceEnabled(config: TradeConfig): boolean {
  return dotGet(config, "alerts.llm_advice", false) === true;
}

export function parseTradeAlertAdvice(text: string): StructuredAdvice | null {
  const parsed = extractJsonFromText(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const result: StructuredAdvice = {
    summary: cleanText(obj.summary, 300),
    actions: cleanList(obj.actions, 3),
    avoid: cleanList(obj.avoid, 2),
    checks: cleanList(obj.checks, 3),
  };
  // The avoid list is expected to name prohibited behavior such as all-in trading.
  const actionableText = [result.summary, ...result.actions].join(" ");
  if (
    !result.summary ||
    result.actions.length !== 3 ||
    !result.avoid.length ||
    !result.checks.length ||
    UNSAFE_CERTAINTY.test(actionableText)
  ) {
    return null;
  }
  return result;
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
    "你是面向金融初学者的交易风险解读助手。只能使用给定告警事实，不得补充实时行情、新闻、价格或用户持仓假设。",
    "目标是解释发生了什么、为什么重要，并给出三种风险承受方式下的情景化行动框架，不是预测涨跌。",
    "禁止保证收益、确定性涨跌、梭哈/满仓、具体仓位比例，以及对具体证券的立即买入或卖出指令。",
    "actions 必须依次覆盖保守、中性、激进三种方式；激进方式也必须限制损失并禁止新增杠杆。",
    "如果输入只是数据源故障，不得给投资动作，只说明应等待数据恢复；不得编造输入中没有的数字。",
    "用通俗中文输出严格 JSON，不要 Markdown，不要 JSON 外文字：",
    '{"summary":"发生了什么及为什么重要","actions":["保守：...","中性：...","激进：..."],"avoid":["不要做什么"],"checks":["下一步复核什么"]}',
    "告警事实：",
    JSON.stringify(facts),
  ].join("\n");
}

function formatStructuredAdvice(advice: StructuredAdvice, heading: string): string {
  const lines = [heading, advice.summary, "可选行动："];
  advice.actions.forEach((item, index) => {
    lines.push(`${index + 1}. ${item}`);
  });
  lines.push(`应避免：${advice.avoid.join("；")}`);
  lines.push(`继续复核：${advice.checks.join("；")}`);
  lines.push("说明：内容仅基于本次公开告警，不了解你的持仓、现金流和亏损承受能力，不构成个性化投资建议。");
  return lines.join("\n");
}

export function buildDeterministicTradeAlertAdvice(alerts: Alert[]): TradeAlertAdvice {
  const critical = alerts.some((alert) => alert.severity === "critical");
  const labels = [...new Set(alerts.map((alert) => alert.rule))].slice(0, 3).join("、");
  const advice: StructuredAdvice = {
    summary: critical
      ? `${labels || "交易"}告警已进入高风险级别。它提示风险暴露需要立即复核，但不能单独证明价格马上上涨或下跌。`
      : `${labels || "交易"}风险正在升温。应先核对告警事实和自身风险承受能力，不要仅凭单条信号决定方向。`,
    actions: [
      critical
        ? "保守：暂停新增风险敞口和杠杆，先确认现有持仓的最大可能亏损"
        : "保守：暂缓新增风险敞口，等待下一次有效数据确认",
      "中性：只按既定计划小额分批执行，预先写清退出条件并保留现金缓冲",
      "激进：若仍参与，只使用可完全承受损失的风险预算，设置明确限损且不新增杠杆",
    ],
    avoid: ["不要因为单条告警追涨杀跌", "不要把历史信号当成确定的涨跌概率"],
    checks: ["复核告警数据的时间和来源", "检查持仓集中度与最大回撤承受能力", "等待下一条独立信号确认"],
  };
  return { text: formatStructuredAdvice(advice, "风险行动框架（本地回退）"), source: "fallback" };
}

export async function generateTradeAlertAdvice(
  alerts: Alert[],
  runner: (prompt: string) => Promise<string> = (prompt) =>
    runAgent(prompt, { task: "alert_advice", timeoutMs: 45_000 }),
): Promise<TradeAlertAdvice> {
  try {
    const parsed = parseTradeAlertAdvice(await runner(buildTradeAlertAdvicePrompt(alerts)));
    if (parsed) return { text: formatStructuredAdvice(parsed, "LLM 风险解读与行动框架"), source: "llm" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[alert-advice] LLM fallback: ${message}\n`);
  }
  return buildDeterministicTradeAlertAdvice(alerts);
}
