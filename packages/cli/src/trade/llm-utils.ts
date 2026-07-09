import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { dotGet, loadTradeConfig } from "./config.js";

const execFileP = promisify(execFile);

const AGENT_BACKENDS = ["grok", "claude", "codex"] as const;
type AgentBackend = (typeof AGENT_BACKENDS)[number];

const PROMPT_ARG_MAX = 4000;
const BACKEND_BLOCK_MS = 10 * 60 * 1000;
const backendBlockedUntil = new Map<AgentBackend, number>();

interface ExecFileError extends Error {
  code?: string | number;
  signal?: string;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

async function execFileClosedStdin(
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer?: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
    child.stdin?.end();
  });
}

async function execFileWithStdin(
  file: string,
  args: string[],
  stdinText: string,
  options: { timeout: number; maxBuffer?: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
    child.stdin?.write(stdinText);
    child.stdin?.end();
  });
}

function promptNeedsFileDelivery(prompt: string): boolean {
  return prompt.length > PROMPT_ARG_MAX;
}

async function writePromptTempFile(prompt: string): Promise<string> {
  const file = join(tmpdir(), `king-ai-prompt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  await writeFile(file, prompt, "utf8");
  return file;
}

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

export function summarizeAgentError(err: unknown): string {
  const e = err as ExecFileError;
  const stdout = e.stdout ? String(e.stdout) : "";
  const stderr = e.stderr ? String(e.stderr) : "";
  const raw = [err instanceof Error ? err.message : String(err), stdout, stderr].filter(Boolean).join("\n");
  const compact = raw
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/personal-team-blocked:spending-limit|run out of credits|need a Grok subscription/i.test(compact)) {
    return "quota blocked: Grok credits or subscription required";
  }
  if (/401 Invalid authentication credentials|Failed to authenticate/i.test(compact)) {
    return "auth failed: invalid or expired credentials";
  }
  if (/no stdin data received/i.test(compact)) {
    return "stdin warning while running non-interactive agent";
  }
  if (/No such file or directory/i.test(compact)) {
    return "agent output file was not created";
  }
  const parts: string[] = [];
  if (e.code !== undefined) parts.push(`exit=${e.code}`);
  if (e.signal) parts.push(`signal=${e.signal}`);
  if (stderr.trim())
    parts.push(
      `stderr=${stderr
        .replace(/\x1b\[[0-9;]*m/g, "")
        .replace(/\s+/g, " ")
        .trim()}`,
    );
  if (stdout.trim())
    parts.push(
      `stdout=${stdout
        .replace(/\x1b\[[0-9;]*m/g, "")
        .replace(/\s+/g, " ")
        .trim()}`,
    );
  if (!parts.length) parts.push(compact);
  const detailed = parts.join(" ");
  return detailed.length > 1000 ? `${detailed.slice(0, 997)}...` : detailed;
}

function shouldBlockBackend(summary: string): boolean {
  return /quota blocked|auth failed/i.test(summary);
}

export function resetAgentBackendBlocks(): void {
  backendBlockedUntil.clear();
}

function isBackendBlocked(name: AgentBackend): boolean {
  const until = backendBlockedUntil.get(name) ?? 0;
  return until > Date.now();
}

function blockBackend(name: AgentBackend): void {
  backendBlockedUntil.set(name, Date.now() + BACKEND_BLOCK_MS);
}

async function runAgentBackend(
  name: AgentBackend,
  prompt: string,
  llmCfg: Record<string, unknown>,
  timeoutMs: number,
): Promise<string> {
  if (name === "claude") {
    const model = String(llmCfg.claude_model ?? "");
    const useStdin = promptNeedsFileDelivery(prompt);
    const args = ["-p", useStdin ? "-" : prompt, "--output-format", "text"];
    if (model) args.unshift("-m", model);
    const execOpts = {
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
      env: process.env,
    };
    const { stdout } = useStdin
      ? await execFileWithStdin("claude", args, prompt, execOpts)
      : await execFileP("claude", args, execOpts);
    return stdout.trim();
  }

  if (name === "codex") {
    const model = String(llmCfg.codex_model ?? "");
    const outputFile = join(
      tmpdir(),
      `king-ai-llm-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    const useStdin = promptNeedsFileDelivery(prompt);
    const args = ["exec", "--sandbox", "read-only", "--output-last-message", outputFile, "--ephemeral"];
    if (model) args.push("-m", model);
    args.push(useStdin ? "-" : prompt);
    const execOpts = {
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
      env: process.env,
    };
    try {
      const { stdout } = useStdin
        ? await execFileWithStdin("codex", args, prompt, execOpts)
        : await execFileClosedStdin("codex", args, execOpts);
      const fileText = await readFile(outputFile, "utf8").catch(() => "");
      return (fileText || stdout).trim();
    } finally {
      await rm(outputFile, { force: true }).catch(() => undefined);
    }
  }

  const model = String(llmCfg.grok_model ?? "");
  const usePromptFile = promptNeedsFileDelivery(prompt);
  const promptFile = usePromptFile ? await writePromptTempFile(prompt) : "";
  try {
    const args = [
      "--no-auto-update",
      "--always-approve",
      "--no-alt-screen",
      ...(usePromptFile ? ["--prompt-file", promptFile] : ["-p", prompt]),
      "--output-format",
      "plain",
    ];
    if (model) args.unshift("-m", model);
    const { stdout } = await execFileP("grok", args, {
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
      env: process.env,
    });
    return stdout.trim();
  } finally {
    if (promptFile) await rm(promptFile, { force: true }).catch(() => undefined);
  }
}

export async function runAgent(prompt: string, options: { timeoutMs?: number; task?: string } = {}): Promise<string> {
  const config = await loadTradeConfig();
  const llmCfg = (dotGet(config, "llm", {}) ?? {}) as Record<string, unknown>;
  const task = options.task ?? "summarize";
  const tasks = (dotGet(config, "llm.agent_tasks", {}) ?? {}) as Record<string, unknown>;
  const taskCfg = (tasks[task] ?? {}) as Record<string, unknown>;
  const configuredTimeout = Number(taskCfg.timeout_ms);
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : (options.timeoutMs ?? 60_000);
  const backends = agentBackendOrder(llmCfg, String(taskCfg.backend ?? ""));

  for (const name of backends) {
    if (isBackendBlocked(name)) continue;
    try {
      const text = await runAgentBackend(name, prompt, llmCfg, timeoutMs);
      if (text) return text;
    } catch (err) {
      const msg = summarizeAgentError(err);
      if (shouldBlockBackend(msg)) blockBackend(name);
      process.stderr.write(`[llm-agent] ${name} failed: ${msg}\n`);
    }
  }
  return "";
}
