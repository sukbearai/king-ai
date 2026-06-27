import { runAgent } from "./llm-utils.js";

function rawFallback(text: string, reason: string): string {
  process.stderr.write(`[llm-summarize] fallback to raw text: ${reason}\n`);
  return stripMarkdown(text.slice(0, 2000));
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

export async function llmSummarize(text: string, label: string): Promise<string> {
  const prompt = [
    `请用中文简洁摘要以下「${label}」内容，保留关键数字和标的名称，不超过 500 字。`,
    "输出要求：纯文本，不要使用任何 Markdown 格式（禁止 # 标题、**加粗**、- 列表、代码块、反引号等）。",
    "可用换行分段，条目用「1.」「2.」编号或「·」开头。",
    "",
    text.slice(0, 12000)
  ].join("\n");
  try {
    const summary = await runAgent(prompt, { timeoutMs: 60_000, task: "summarize" });
    if (summary.trim()) return stripMarkdown(summary.trim());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[llm-summarize] agent error: ${msg}\n`);
  }
  return rawFallback(text, "local agent unavailable");
}

export async function batchSummarize(blocks: Array<{ label: string; text: string }>): Promise<string[]> {
  return Promise.all(
    blocks.map(async (block) => {
      if (!block.text.trim()) return "";
      return llmSummarize(block.text, block.label);
    })
  );
}