import { runAgent } from "./llm-utils.js";

function rawFallback(text: string, reason: string): string {
  process.stderr.write(`[llm-summarize] fallback to raw text: ${reason}\n`);
  return text.slice(0, 2000);
}

export async function llmSummarize(text: string, label: string): Promise<string> {
  const prompt = `请用中文简洁摘要以下「${label}」内容，保留关键数字和标的名称，不超过 500 字：\n\n${text.slice(0, 12000)}`;
  try {
    const summary = await runAgent(prompt, { timeoutMs: 60_000, task: "summarize" });
    if (summary.trim()) return summary.trim();
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