import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dotGet, loadTradeConfig } from "./config.js";

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
      if (err) reject(attachExecFileOutput(err, stdout, stderr));
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
      if (err) reject(attachExecFileOutput(err, stdout, stderr));
      else resolve({ stdout, stderr });
    });
    child.stdin?.write(stdinText);
    child.stdin?.end();
  });
}

export function attachExecFileOutput(err: unknown, stdout: string | Buffer, stderr: string | Buffer): Error {
  const target = (err instanceof Error ? err : new Error(String(err))) as ExecFileError;
  target.stdout = stdout;
  target.stderr = stderr;
  return target;
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
  const objStart = body.indexOf("{");
  const objEnd = body.lastIndexOf("}");
  const arrStart = body.indexOf("[");
  const arrEnd = body.lastIndexOf("]");
  const tryParse = (start: number, end: number): unknown => {
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return undefined;
    }
  };
  // Parse whichever structure opens first: an object body may legitimately
  // contain arrays (e.g. {"entities":[]}), so slicing [..] first would
  // return the inner array and drop the enclosing object.
  const objectFirst = objStart >= 0 && (arrStart < 0 || objStart < arrStart);
  const first = objectFirst ? tryParse(objStart, objEnd) : tryParse(arrStart, arrEnd);
  if (first !== undefined) return first;
  const second = objectFirst ? tryParse(arrStart, arrEnd) : tryParse(objStart, objEnd);
  if (second !== undefined) return second;
  return null;
}

export function salvageAgentErrorStdout(err: unknown): string {
  const e = err as ExecFileError;
  if (e.stdout == null) return "";
  const stdout = String(e.stdout).trim();
  if (!stdout) return "";
  if (extractJsonFromText(stdout) === null) return "";
  return stdout;
}

function normalizeBackend(raw: string): AgentBackend | null {
  const v = raw.trim().toLowerCase();
  if (v === "gemini" || v === "api") return "grok";
  if (AGENT_BACKENDS.includes(v as AgentBackend)) return v as AgentBackend;
  return null;
}

export function resolveAgentBackendOrder(llmCfg: Record<string, unknown>, taskBackend?: string): AgentBackend[] {
  const configured = [taskBackend, llmCfg.default_backend, llmCfg.provider, "grok"];
  let preferred: AgentBackend | null = null;
  for (const raw of configured) {
    if (raw == null || !String(raw).trim()) continue;
    preferred = normalizeBackend(String(raw));
    if (preferred) break;
  }
  const order: AgentBackend[] = preferred ? [preferred] : [];
  for (const name of AGENT_BACKENDS) {
    if (!order.includes(name)) order.push(name);
  }
  return order;
}

function sanitizeFailureText(text: string): string {
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  if (/^Command failed:/i.test(stripped.trim())) return "agent command failed";
  return stripped
    .replace(/\b(?:sk|xai)-[A-Za-z0-9_-]{12,}\b/g, "<redacted>")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "<redacted>")
    .replace(/(api[_-]?key|token|secret|password|authorization|bearer)\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .replace(/\s+/g, " ")
    .trim();
}

export function summarizeAgentError(err: unknown): string {
  const e = err as ExecFileError;
  const stdout = e.stdout ? String(e.stdout) : "";
  const stderr = e.stderr ? String(e.stderr) : "";
  const raw = [err instanceof Error ? err.message : String(err), stdout, stderr].filter(Boolean).join("\n");
  const rawCompact = raw
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const compact = sanitizeFailureText(raw);
  if (/personal-team-blocked:spending-limit|run out of credits|need a Grok subscription/i.test(rawCompact)) {
    return "quota blocked: Grok credits or subscription required";
  }
  if (/401 Invalid authentication credentials|Failed to authenticate/i.test(rawCompact)) {
    return "auth failed: invalid or expired credentials";
  }
  if (/no stdin data received/i.test(rawCompact)) {
    return "stdin warning while running non-interactive agent";
  }
  if (/No such file or directory/i.test(rawCompact)) {
    return "agent output file was not created";
  }
  const parts: string[] = [];
  if (e.code !== undefined) parts.push(`exit=${e.code}`);
  if (e.signal) parts.push(`signal=${e.signal}`);
  if (stderr.trim()) parts.push(`stderr=${sanitizeFailureText(stderr)}`);
  if (stdout.trim()) parts.push(`stdout=${sanitizeFailureText(stdout)}`);
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
      : await execFileClosedStdin("claude", args, execOpts);
    return stdout.trim();
  }

  if (name === "codex") {
    const model = String(llmCfg.codex_model ?? "");
    const outputFile = join(
      tmpdir(),
      `king-ai-llm-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    const useStdin = promptNeedsFileDelivery(prompt);
    const args = buildCodexArgs(prompt, outputFile, model);
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
    const { stdout } = await execFileClosedStdin("grok", args, {
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
      env: process.env,
    });
    return stdout.trim();
  } finally {
    if (promptFile) await rm(promptFile, { force: true }).catch(() => undefined);
  }
}

export function buildCodexArgs(prompt: string, outputFile: string, model = ""): string[] {
  const args = [
    "exec",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--output-last-message",
    outputFile,
    "--ephemeral",
  ];
  if (model) args.push("-m", model);
  args.push(promptNeedsFileDelivery(prompt) ? "-" : prompt);
  return args;
}

export type AgentBackendRunner = (
  name: AgentBackend,
  prompt: string,
  llmCfg: Record<string, unknown>,
  timeoutMs: number,
) => Promise<string>;

export interface RunAgentOptions {
  timeoutMs?: number;
  task?: string;
  required?: boolean;
  /** Narrow seam for tests; normal callers use the loaded trade config and local CLIs. */
  config?: Record<string, unknown>;
  backendRunner?: AgentBackendRunner;
}

export async function runAgent(prompt: string, options: RunAgentOptions = {}): Promise<string> {
  const config = options.config ?? (await loadTradeConfig());
  const llmCfg = (dotGet(config, "llm", {}) ?? {}) as Record<string, unknown>;
  const task = options.task ?? "summarize";
  const tasks = (dotGet(config, "llm.agent_tasks", {}) ?? {}) as Record<string, unknown>;
  const taskCfg = (tasks[task] ?? {}) as Record<string, unknown>;
  const configuredTimeout = Number(taskCfg.timeout_ms);
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : (options.timeoutMs ?? 60_000);
  const taskBackend = typeof taskCfg.backend === "string" ? taskCfg.backend : undefined;
  const backends = resolveAgentBackendOrder(llmCfg, taskBackend);
  const outcomes: string[] = [];
  const backendRunner = options.backendRunner ?? runAgentBackend;

  for (const name of backends) {
    if (isBackendBlocked(name)) {
      outcomes.push(`${name}=blocked`);
      continue;
    }
    try {
      const text = (await backendRunner(name, prompt, llmCfg, timeoutMs)).trim();
      if (text) return text;
      outcomes.push(`${name}=empty output`);
    } catch (err) {
      const salvaged = salvageAgentErrorStdout(err);
      if (salvaged) {
        const msg = summarizeAgentError(err);
        process.stderr.write(`[llm-agent] ${name} error but stdout salvaged: ${msg.slice(0, 120)}\n`);
        return salvaged;
      }
      const msg = summarizeAgentError(err);
      if (shouldBlockBackend(msg)) blockBackend(name);
      outcomes.push(`${name}=${msg.slice(0, 180)}`);
      process.stderr.write(`[llm-agent] ${name} failed: ${msg}\n`);
    }
  }
  if (options.required) {
    throw new Error(`required agent task ${task} unavailable: ${outcomes.join("; ")}`);
  }
  return "";
}
