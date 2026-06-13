import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dotGet, loadTradeConfig } from "./config.js";

const execFileP = promisify(execFile);

export function extractJsonFromText(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text) ?? "";
  const arrStart = body.indexOf("[");
  const arrEnd = body.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      return JSON.parse(body.slice(arrStart, arrEnd + 1));
    } catch {
      // fall through
    }
  }
  const objStart = body.indexOf("{");
  const objEnd = body.lastIndexOf("}");
  if (objStart >= 0 && objEnd > objStart) {
    try {
      return JSON.parse(body.slice(objStart, objEnd + 1));
    } catch {
      return null;
    }
  }
  return null;
}

export async function runAgent(
  prompt: string,
  options: { timeoutMs?: number; task?: string } = {}
): Promise<string> {
  const config = await loadTradeConfig();
  const llmCfg = (dotGet(config, "llm", {}) ?? {}) as Record<string, unknown>;
  const task = options.task ?? "summarize";
  const tasks = (dotGet(config, "llm.agent_tasks", {}) ?? {}) as Record<string, unknown>;
  const taskCfg = (tasks[task] ?? {}) as Record<string, unknown>;
  const backend = String(taskCfg.backend ?? llmCfg.default_backend ?? "claude");
  const timeoutMs = options.timeoutMs ?? 60_000;

  const backends = backend === "api"
    ? ["api"]
    : [backend, "claude", "codex", "api"];

  for (const name of backends) {
    try {
      if (name === "claude") {
        const model = String(llmCfg.claude_model ?? "");
        const args = ["-p", prompt, "--output-format", "text"];
        if (model) args.unshift("-m", model);
        const { stdout } = await execFileP("claude", args, {
          timeout: timeoutMs,
          maxBuffer: 5 * 1024 * 1024,
          env: process.env
        });
        if (stdout.trim()) return stdout.trim();
      } else if (name === "codex") {
        const model = String(llmCfg.codex_model ?? "");
        const args = ["exec", "-s", "read-only", "-o", "/tmp/king-ai-llm-out.txt"];
        if (model) args.push("-m", model);
        args.push(prompt);
        await execFileP("codex", args, { timeout: timeoutMs, env: process.env });
        const { stdout } = await execFileP("cat", ["/tmp/king-ai-llm-out.txt"], { timeout: 5000 });
        if (stdout.trim()) return stdout.trim();
      } else if (name === "api") {
        const result = await callLlmApi(prompt, llmCfg);
        if (result) return result;
      }
    } catch {
      continue;
    }
  }
  return "";
}

async function callLlmApi(prompt: string, llmCfg: Record<string, unknown>): Promise<string> {
  const geminiKey = String(process.env.GEMINI_API_KEY ?? llmCfg.gemini_api_key ?? "");
  if (geminiKey) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
          signal: AbortSignal.timeout(30_000)
        }
      );
      if (res.ok) {
        const body = (await res.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const text = body.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        if (text) return text;
      }
    } catch {
      // fall through
    }
  }
  return "";
}