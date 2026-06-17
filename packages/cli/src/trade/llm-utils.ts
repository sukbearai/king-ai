import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dotGet, loadTradeConfig } from "./config.js";

const execFileP = promisify(execFile);

const AGENT_BACKENDS = ["grok", "claude", "codex"] as const;
type AgentBackend = typeof AGENT_BACKENDS[number];

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

function normalizeBackend(raw: string): AgentBackend | null {
  const v = raw.trim().toLowerCase();
  if (v === "gemini" || v === "api") return "grok";
  if (AGENT_BACKENDS.includes(v as AgentBackend)) return v as AgentBackend;
  return null;
}

function agentBackendOrder(llmCfg: Record<string, unknown>, taskBackend?: string): AgentBackend[] {
  const preferred = normalizeBackend(String(taskBackend ?? llmCfg.default_backend ?? llmCfg.provider ?? "grok"));
  const order: AgentBackend[] = preferred ? [preferred] : [];
  for (const name of AGENT_BACKENDS) {
    if (!order.includes(name)) order.push(name);
  }
  return order;
}

async function runAgentBackend(
  name: AgentBackend,
  prompt: string,
  llmCfg: Record<string, unknown>,
  timeoutMs: number
): Promise<string> {
  if (name === "claude") {
    const model = String(llmCfg.claude_model ?? "");
    const args = ["-p", prompt, "--output-format", "text"];
    if (model) args.unshift("-m", model);
    const { stdout } = await execFileP("claude", args, {
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
      env: process.env
    });
    return stdout.trim();
  }

  if (name === "codex") {
    const model = String(llmCfg.codex_model ?? "");
    const args = ["exec", "-s", "read-only", "-o", "/tmp/king-ai-llm-out.txt"];
    if (model) args.push("-m", model);
    args.push(prompt);
    await execFileP("codex", args, { timeout: timeoutMs, env: process.env });
    const { stdout } = await execFileP("cat", ["/tmp/king-ai-llm-out.txt"], { timeout: 5000 });
    return stdout.trim();
  }

  const model = String(llmCfg.grok_model ?? "");
  const args = [
    "--no-auto-update",
    "--always-approve",
    "--no-alt-screen",
    "-p",
    prompt,
    "--output-format",
    "plain"
  ];
  if (model) args.unshift("-m", model);
  const { stdout } = await execFileP("grok", args, {
    timeout: timeoutMs,
    maxBuffer: 5 * 1024 * 1024,
    env: process.env
  });
  return stdout.trim();
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
  const configuredTimeout = Number(taskCfg.timeout_ms);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : options.timeoutMs ?? 60_000;
  const backends = agentBackendOrder(llmCfg, String(taskCfg.backend ?? ""));

  for (const name of backends) {
    try {
      const text = await runAgentBackend(name, prompt, llmCfg, timeoutMs);
      if (text) return text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[llm-agent] ${name} failed: ${msg}\n`);
    }
  }
  return "";
}
