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
    `请用中文简洁摘要以下「${label}」内容，保留关键数字和标的名称，不超过 500 字。`,
    "输出要求：纯文本，不要使用任何 Markdown 格式（禁止 # 标题、**加粗**、- 列表、代码块、反引号等）。",
    "可用换行分段，条目用「1.」「2.」编号或「·」开头。",
    ...(instruction ? [instruction] : []),
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
