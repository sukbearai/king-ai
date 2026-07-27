import { runAgent } from "./llm-utils.js";

const FALLBACK_MAX_LINES = 12;
const FALLBACK_MAX_CHARS = 1400;

export function compactSummaryFallback(text: string): string {
  const cleaned = stripMarkdown(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of cleaned) {
    const normalized = line.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    lines.push(line);
    if (lines.length >= FALLBACK_MAX_LINES) break;
  }
  const compact = lines.join("\n");
  if (compact.length <= FALLBACK_MAX_CHARS) return compact;
  return `${compact.slice(0, FALLBACK_MAX_CHARS - 1).trimEnd()}…`;
}

function localFallback(text: string, reason: string): string {
  process.stderr.write(`[llm-summarize] fallback to compact local text: ${reason}\n`);
  return compactSummaryFallback(text);
}

export function stripMarkdown(text: string): string {
  let out = text.trim();
  out = out.replace(/```[\w-]*\n?([\s\S]*?)```/g, "$1");
  out = out.replace(/`([^`]+)`/g, "$1");
  out = out.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/__([^_]+)__/g, "$1");
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1");
  out = out.replace(/(?<!_)_([^_]+)_(?!_)/g, "$1");
  out = out.replace(/^#{1,6}\s+/gm, "");
  out = out.replace(/^>\s?/gm, "");
  out = out.replace(/^[-*_]{3,}\s*$/gm, "");
  return out.trim();
}

export function buildSummaryPrompt(
  text: string,
  label: string,
  instruction?: string,
  maxInputChars: number | null = 12_000,
): string {
  const input = maxInputChars === null ? text : text.slice(0, maxInputChars);
  return [
    `你在写交易晨报里的「${label}」小节：给忙着看盘的人看，要有判断，不要流水账。`,
    "用中文，不超过 500 字；保留关键数字、标的、时间。",
    "纯文本：禁止 Markdown（# 标题、**加粗**、- 列表、代码块、反引号）。",
    "可用换行；条目用「1.」「2.」或「·」。合并重复，弱相关一笔带过。",
    ...(instruction ? [instruction] : ["按市场影响排序；写清发生了什么、为何要紧。"]),
    "",
    input,
  ].join("\n");
}

export async function llmSummarize(
  text: string,
  label: string,
  instruction?: string,
  options: { maxInputChars?: number | null; timeoutMs?: number } = {},
): Promise<string> {
  const prompt = buildSummaryPrompt(text, label, instruction, options.maxInputChars);
  try {
    const summary = await runAgent(prompt, { timeoutMs: options.timeoutMs ?? 60_000, task: "summarize" });
    if (summary.trim()) return stripMarkdown(summary.trim());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[llm-summarize] agent error: ${msg}\n`);
  }
  return localFallback(text, "local agent unavailable");
}

export async function batchSummarize(
  blocks: Array<{ label: string; text: string; instruction?: string }>,
): Promise<string[]> {
  return Promise.all(
    blocks.map(async (block) => {
      if (!block.text.trim()) return "";
      return llmSummarize(block.text, block.label, block.instruction);
    }),
  );
}
