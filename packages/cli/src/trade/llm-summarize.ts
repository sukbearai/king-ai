import { dotGet, loadTradeConfig } from "./config.js";

export async function llmSummarize(text: string, label: string): Promise<string> {
  const config = await loadTradeConfig();
  const provider = String(dotGet(config, "llm.provider", "gemini"));
  const apiKey = String(
    dotGet(config, "llm.gemini_api_key", "")
    || process.env.GEMINI_API_KEY
    || ""
  );

  if (!apiKey || provider !== "gemini") {
    return text.slice(0, 2000);
  }

  const prompt = `请用中文简洁摘要以下「${label}」内容，保留关键数字和标的名称，不超过 500 字：\n\n${text.slice(0, 12000)}`;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        }),
        signal: AbortSignal.timeout(60_000)
      }
    );
    if (!res.ok) return text.slice(0, 2000);
    const body = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return body.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || text.slice(0, 2000);
  } catch {
    return text.slice(0, 2000);
  }
}

export async function batchSummarize(blocks: Array<{ label: string; text: string }>): Promise<string[]> {
  const results: string[] = [];
  for (const block of blocks) {
    if (!block.text.trim()) {
      results.push("");
      continue;
    }
    results.push(await llmSummarize(block.text, block.label));
  }
  return results;
}