import { execFileSync, spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { join, delimiter as PATH_DELIMITER } from "node:path";
import type {
  EngineAdapter,
  EngineClassifyArgs,
  EngineId,
  EngineProbeArgs,
  EngineResult,
  EngineRunArgs,
  EngineSession,
  EngineTurnOptions,
  EngineUsage,
  JsonSchema,
} from "./types.js";
import { cleanLine, stripLoneSurrogates } from "./text.js";

const IS_WIN = process.platform === "win32";
const DOCTOR_PROMPT = "Connectivity check. Reply with exactly: OK";
const MAX_FAILURE_CHARS = 4000;
const DEFAULT_SESSION_NO_OUTPUT_TIMEOUT_MS = 300_000;

function envDurationMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : fallback;
}

function turnTimeoutMs(): number {
  return envDurationMs("KING_AI_TURN_TIMEOUT_MS", 0);
}

function sessionTimeoutMs(): number {
  return envDurationMs("KING_AI_SESSION_TIMEOUT_MS", 0);
}

function sessionNoOutputTimeoutMs(): number {
  return envDurationMs("KING_AI_SESSION_NO_OUTPUT_TIMEOUT_MS", DEFAULT_SESSION_NO_OUTPUT_TIMEOUT_MS);
}

function engineNoOutputError(engine: EngineId, ms: number): string {
  return `${engine} engine produced no output for ${Math.round(ms / 1000)}s after session.send - aborted; possible quota, authentication/login, or interactive prompt issue; run ${engine} locally and re-run king-ai agent computer --doctor`;
}

export function splitExtraArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  for (const ch of raw) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaping) current += "\\";
  if (current) args.push(current);
  return args;
}

function envExtraArgs(...names: string[]): string[] {
  for (const name of names) {
    const args = splitExtraArgs(process.env[name]);
    if (args.length) return args;
  }
  return [];
}

function pushTail(lines: string[], line: string, max = 80): void {
  lines.push(line);
  if (lines.length > max) lines.splice(0, lines.length - max);
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (
        part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

export const ENGINE_PREFERENCE_ORDER: EngineId[] = ["grok", "claude", "codex"];

export function createGrokLogSink(onLog: (line: string) => void): (line: string) => void {
  let textBuffer = "";
  let thoughtBuffer = "";
  const flushThought = () => {
    const text = thoughtBuffer.replace(/\s+/g, " ").trim();
    thoughtBuffer = "";
    if (text) onLog(`[grok] (thinking) ${text.slice(0, 500)}`);
  };
  const flushText = () => {
    const text = textBuffer.replace(/\s+/g, " ").trim();
    textBuffer = "";
    if (text) onLog(`[grok] ${text.slice(0, 500)}`);
  };
  const flushBuffered = () => {
    flushThought();
    flushText();
  };
  return (line: string) => {
    const cleaned = cleanLine(line);
    if (!cleaned) return;
    if (!cleaned.startsWith("{")) {
      flushBuffered();
      onLog(cleaned);
      return;
    }
    try {
      const obj = JSON.parse(cleaned) as Record<string, unknown>;
      if (obj.type === "thought" && typeof obj.data === "string") {
        thoughtBuffer += obj.data;
        return;
      }
      if (obj.type === "text" && typeof obj.data === "string") {
        // Emit thinking before text so the activity feed stays in stream order.
        flushThought();
        textBuffer += obj.data;
        return;
      }
      flushBuffered();
      const display = formatEngineLogLine("grok", cleaned);
      if (display) onLog(display);
    } catch {
      flushBuffered();
      onLog(cleaned);
    }
  };
}

export function formatEngineLogLine(engine: EngineId, line: string): string | null {
  const cleaned = cleanLine(line);
  if (!cleaned) return null;
  if (!cleaned.startsWith("{")) return cleaned;
  try {
    const obj = JSON.parse(cleaned) as Record<string, unknown>;
    if (engine === "claude") {
      if (obj.type === "system" && obj.subtype === "init") return "[claude] session initialized";
      if (obj.type === "assistant") {
        const message = obj.message as { content?: unknown } | undefined;
        const content = message?.content;
        const lines: string[] = [];
        const text = textOfContent(content).replace(/\s+/g, " ").trim();
        if (text) lines.push(`[claude] ${text.slice(0, 500)}`);
        if (Array.isArray(content)) {
          for (const part of content) {
            if (!part || typeof part !== "object" || !("type" in part) || part.type !== "tool_use") continue;
            const tool = part as { name?: unknown; input?: unknown };
            const toolName = typeof tool.name === "string" && tool.name.trim() ? tool.name : "tool";
            const input = tool.input;
            const command =
              input && typeof input === "object" && "command" in input && typeof input.command === "string"
                ? input.command
                : null;
            if (command) {
              lines.push(`[claude] $ ${command.replace(/\s+/g, " ").slice(0, 500)}`);
              continue;
            }
            let compact = "";
            try {
              compact = JSON.stringify(input ?? {}).replace(/\s+/g, " ");
            } catch {
              compact = String(input ?? "");
            }
            lines.push(`[claude] -> ${toolName} ${compact.slice(0, 120)}`);
          }
        }
        return lines.length ? lines.join("\n") : null;
      }
      if (obj.type === "user") {
        const message = obj.message as { content?: unknown } | undefined;
        const text = textOfContent(message?.content).replace(/\s+/g, " ").trim();
        return text ? `[tool] ${text.slice(0, 500)}` : null;
      }
      if (obj.type === "result") {
        if (obj.is_error === true) return `[claude] failed: ${String(obj.result ?? "error").slice(0, 500)}`;
        return "[claude] turn completed";
      }
      if (obj.subtype === "status" && obj.status === "compacting") return "[claude] native context compaction started";
      if (obj.subtype === "compact_boundary") return "[claude] native context compaction finished";
      return null;
    }
    if (engine === "codex") {
      if (process.env.KING_AI_CODEX_VERBOSE === "1") return cleaned;
      const method = typeof obj.method === "string" ? obj.method : "";
      const params = obj.params as { item?: { type?: unknown; command?: unknown; text?: unknown } } | undefined;
      const item = params?.item;
      if (method === "item/started" && item?.type === "commandExecution" && typeof item.command === "string") {
        return `[codex] $ ${item.command.replace(/\s+/g, " ").slice(0, 500)}`;
      }
      if (method === "item/completed" && item?.type === "agentMessage" && typeof item.text === "string") {
        return `[codex] ${item.text.replace(/\s+/g, " ").slice(0, 500)}`;
      }
      if (method === "turn/completed") return "[codex] turn completed";
      return null;
    }
    if (engine === "grok") {
      if (obj.type === "text" && typeof obj.data === "string" && obj.data.trim()) {
        return `[grok] ${obj.data.replace(/\s+/g, " ").slice(0, 500)}`;
      }
      if (obj.type === "end") return "[grok] turn completed";
      if (obj.type === "error") return `[grok] failed: ${String(obj.message ?? "error").slice(0, 500)}`;
      const update = (
        obj.params as
          | { update?: { sessionUpdate?: unknown; rawInput?: { command?: unknown }; title?: unknown } }
          | undefined
      )?.update;
      if (update?.sessionUpdate === "tool_call" && update.rawInput && typeof update.rawInput.command === "string") {
        return `[grok] $ ${update.rawInput.command.replace(/\s+/g, " ").slice(0, 500)}`;
      }
      if (update?.sessionUpdate === "tool_call_update" && typeof update.title === "string" && update.title.trim()) {
        return `[grok] ${update.title.replace(/\s+/g, " ").slice(0, 500)}`;
      }
      return null;
    }
  } catch {
    return cleaned;
  }
  return cleaned;
}

function resolveSpawn(bin: string): { command: string; shell: boolean; wantsStdinPrompt: boolean } {
  if (!IS_WIN) return { command: bin, shell: false, wantsStdinPrompt: false };
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const dir of (process.env.PATH ?? "").split(PATH_DELIMITER)) {
    for (const ext of ["", ...exts]) {
      const candidate = join(dir, bin + ext);
      if (existsSync(candidate)) {
        const batch = /\.(cmd|bat)$/i.test(candidate);
        return { command: candidate, shell: batch, wantsStdinPrompt: batch };
      }
    }
  }
  return { command: bin, shell: true, wantsStdinPrompt: true };
}

export async function binOnPath(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn(IS_WIN ? "where" : "which", [bin], { stdio: "ignore" });
    probe.on("error", () => resolve(false));
    probe.on("close", (code) => resolve(code === 0));
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureCommonHome(home: string): Promise<void> {
  await mkdir(join(home, "memory"), { recursive: true });
  await mkdir(join(home, "notes"), { recursive: true });
  await mkdir(join(home, "workspace"), { recursive: true });
  const index = join(home, "memory", "MEMORY.md");
  if (!(await exists(index))) {
    await writeFile(
      index,
      "# Memory index\n\nOne line per durable fact, pointing at the file that holds it:\n`- [Title](file.md) - one-line hook`\n\nWrite the fact itself in its own `memory/<topic>.md` file; keep this index short.\n",
      "utf8",
    );
  }
}

export function personaHeader(persona: { id: string; name: string; role?: string }): string {
  return `# ${persona.name}${persona.role ? ` - ${persona.role}` : ""}

You are ${persona.name}, a teammate running from this local agent home.

This directory is your private home and working directory. It persists across wakes and is yours alone.

Layout:
- CLAUDE.md this file; keep it short.
- memory/ durable notes indexed by memory/MEMORY.md.
- notes/ scratch notes and reply drafts.
- .claude/skills/ your skills.
- workspace/ project files, clones, downloads, builds, and temporary work. Use workspace/ for project work instead of cluttering the home root.

Privacy boundary:
- Stay inside this home directory unless the operator explicitly asks otherwise in this runtime.
- Do not read, list, search, quote, summarize, or send files outside this home directory.
- If a task seems to need a file outside this home, ask in the runtime first.

Use the \`king-ai\` command on PATH to interact with the remote runtime.
`;
}

async function seedPersonaFile(path: string, persona: { id: string; name: string; role?: string }): Promise<void> {
  const next = personaHeader(persona);
  if (!(await exists(path))) {
    await writeFile(path, next, "utf8");
    return;
  }
  const current = await readFile(path, "utf8").catch(() => "");
  if (!current.includes("You are ") || !current.includes("a teammate running from this local agent home.")) return;
  await writeFile(path, next, "utf8");
}

function failurePreview(
  exitCode: number,
  signalName: NodeJS.Signals | null,
  stderr: string[],
  stdout: string[],
): string {
  const detail = [...stderr, ...stdout].join("\n").trim();
  const prefix = signalName ? `process terminated by ${signalName}` : `process exited with code ${exitCode}`;
  return detail ? `${prefix}\n${detail}`.slice(0, MAX_FAILURE_CHARS) : prefix;
}

export function claudeStreamUserMessage(text: string): string {
  return (
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: stripLoneSurrogates(text) }] },
    }) + "\n"
  );
}

export interface CodexAppEventState {
  activeTurnId: string | null;
  steerGate: boolean;
}

export interface CodexAppEventResult {
  logs: string[];
  activeTurnId: string | null;
  steerGate: boolean;
  turnCompletedError?: string;
  usage?: unknown;
  threadId?: string;
  agentMessage?: string;
}

type CodexUserInput = { type: "text"; text: string; text_elements: [] } | { type: "localImage"; path: string };

function codexUserInput(text: string, imagePaths: readonly string[] = []): CodexUserInput[] {
  return [
    { type: "text", text: stripLoneSurrogates(text), text_elements: [] },
    ...imagePaths.filter((path) => path.trim()).map((path) => ({ type: "localImage" as const, path })),
  ];
}

function codexImageArgs(imagePaths: readonly string[] | undefined): string[] {
  return (imagePaths ?? []).filter((path) => path.trim()).flatMap((path) => ["--image", path]);
}

function unknownRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function parseJsonText(text: string): { ok: true; value: unknown } | { ok: false } {
  const cleaned = stripLoneSurrogates(text).trim();
  if (!cleaned) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch {
    for (const line of cleaned.split("\n").reverse()) {
      try {
        return { ok: true, value: JSON.parse(line) };
      } catch {
        // Try the preceding line.
      }
    }
    return { ok: false };
  }
}

function missingStructuredOutputError(engine: EngineId): string {
  return `${engine} engine completed without a valid structured output`;
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | null {
  return unknownRecord(unknownRecord(value)?.[key]);
}

function errorMessage(value: unknown, fallback: string): string {
  const rec = unknownRecord(value);
  const nested = unknownRecord(rec?.error);
  const message = rec?.message ?? nested?.message;
  return typeof message === "string" && message.trim() ? message.slice(0, MAX_FAILURE_CHARS) : fallback;
}

export function reduceCodexAppEvent(state: CodexAppEventState, msg: Record<string, unknown>): CodexAppEventResult {
  const logs: string[] = [];
  let activeTurnId = state.activeTurnId;
  let steerGate = state.steerGate;
  const method = typeof msg.method === "string" ? msg.method : "";
  const result = unknownRecord(msg.result);
  const params = unknownRecord(msg.params);
  const threadId =
    nestedRecord(result, "thread")?.id ??
    (method === "thread/started" ? nestedRecord(params, "thread")?.id : undefined);
  const turnId =
    nestedRecord(result, "turn")?.id ??
    result?.turnId ??
    (method === "turn/started" ? nestedRecord(params, "turn")?.id : undefined);

  if (typeof turnId === "string") {
    activeTurnId = turnId;
    steerGate = false;
  }

  if (method === "thread/tokenUsage/updated") {
    return { logs, activeTurnId, steerGate, usage: nestedRecord(params, "tokenUsage")?.total };
  }

  if (method === "account/rateLimits/updated") {
    const pct = unknownRecord(nestedRecord(params, "rateLimits")?.primary)?.usedPercent;
    if (typeof pct === "number" && pct >= 90)
      logs.push(`[codex] account rate limit at ${Math.round(pct)}% - turns will start failing when it reaches 100%`);
    return { logs, activeTurnId, steerGate };
  }

  if (method === "item/started" || method === "item/completed") {
    const item = nestedRecord(params, "item");
    const type = item?.type;
    if (type === "contextCompaction") {
      logs.push(`[codex] native context compaction ${method === "item/started" ? "started" : "finished"}`);
    } else if (item && type === "commandExecution" && method === "item/started" && typeof item.command === "string") {
      logs.push(`[codex] $ ${item.command.replace(/\s+/g, " ").slice(0, 200)}`);
    } else if (
      item &&
      type === "agentMessage" &&
      method === "item/completed" &&
      typeof item.text === "string" &&
      item.text.trim()
    ) {
      logs.push(`[codex] ${item.text.replace(/\s+/g, " ").slice(0, 200)}`);
      return { logs, activeTurnId, steerGate: true, agentMessage: item.text };
    }
    if (method === "item/completed") steerGate = true;
    return { logs, activeTurnId, steerGate };
  }

  if (
    method === "item/agentMessage/delta" ||
    method === "item/reasoning/textDelta" ||
    method === "item/reasoning/summaryTextDelta"
  ) {
    return { logs, activeTurnId, steerGate: false };
  }

  if (method === "turn/completed") {
    const turn = nestedRecord(params, "turn") ?? nestedRecord(result, "turn");
    const failed =
      turn?.status === "failed" ? String(nestedRecord(turn, "error")?.message ?? "codex turn failed") : undefined;
    return { logs, activeTurnId: null, steerGate: false, turnCompletedError: failed };
  }

  return { logs, activeTurnId, steerGate, threadId: typeof threadId === "string" ? threadId : undefined };
}

function spawnCapture(
  bin: string,
  args: string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    shell?: boolean;
    stdinText?: string;
    onLog?: (line: string) => void;
  },
): Promise<{ text: string; error?: string; usage?: EngineUsage }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: [opts.stdinText == null ? "ignore" : "pipe", "pipe", "pipe"],
      shell: opts.shell ?? false,
    });
    if (opts.stdinText != null) {
      child.stdin?.write(opts.stdinText);
      child.stdin?.end();
    }
    const onAbort = () => child.kill("SIGTERM");
    opts.signal.addEventListener("abort", onAbort, { once: true });
    let stdout = "";
    const stderr: string[] = [];
    child.stdout?.on("data", (buf) => {
      const text = buf.toString("utf8");
      stdout += text;
      const line = cleanLine(text);
      if (line) opts.onLog?.(line);
    });
    child.stderr?.on("data", (buf) => {
      for (const raw of buf.toString("utf8").split("\n")) {
        const line = cleanLine(raw);
        if (line) stderr.push(line);
      }
    });
    child.on("error", (err) => {
      opts.signal.removeEventListener("abort", onAbort);
      resolve({ text: "", error: err.message });
    });
    child.on("close", (code, signalName) => {
      opts.signal.removeEventListener("abort", onAbort);
      const exitCode = code ?? (signalName ? 128 : 1);
      resolve({
        text: stdout.trim(),
        error: exitCode === 0 ? undefined : failurePreview(exitCode, signalName, stderr, []),
      });
    });
  });
}

function spawnEngine(
  bin: string,
  args: string[],
  opts: EngineRunArgs & { engine: EngineId; shell?: boolean; stdinText?: string },
): Promise<EngineResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.home,
      env: opts.env,
      stdio: [opts.stdinText == null ? "ignore" : "pipe", "pipe", "pipe"],
      shell: opts.shell ?? false,
    });
    if (opts.stdinText != null) {
      child.stdin?.write(opts.stdinText);
      child.stdin?.end();
    }

    const stderr: string[] = [];
    const stdout: string[] = [];
    let sessionId: string | null = null;
    let usage: EngineUsage | undefined;
    let model: string | null = null;
    let structuredOutput: unknown;
    let hasStructuredOutput = false;
    let timer: NodeJS.Timeout | null = null;
    const onAbort = () => child.kill("SIGTERM");
    opts.signal.addEventListener("abort", onAbort, { once: true });
    const timeoutMs = turnTimeoutMs();
    if (timeoutMs > 0) timer = setTimeout(onAbort, timeoutMs);

    child.stdout?.on("data", (buf) => {
      for (const raw of buf.toString("utf8").split("\n")) {
        const line = cleanLine(raw);
        if (!line) continue;
        stdout.push(line);
        opts.onLog(line);
        if (!line.startsWith("{")) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (typeof obj.session_id === "string") sessionId = obj.session_id;
          if (obj.type === "result" && typeof obj.usage === "object") usage = obj.usage as EngineUsage;
          if (obj.type === "result" && Object.hasOwn(obj, "structured_output")) {
            structuredOutput = obj.structured_output;
            hasStructuredOutput = true;
          }
          const message = obj.message as { model?: unknown } | undefined;
          if (typeof obj.model === "string") model = obj.model;
          if (typeof message?.model === "string") model = message.model;
        } catch {
          // Ignore non-event JSON.
        }
      }
    });
    child.stderr?.on("data", (buf) => {
      for (const raw of buf.toString("utf8").split("\n")) {
        const line = cleanLine(raw);
        if (!line) continue;
        stderr.push(line);
        opts.onLog(line);
      }
    });
    child.on("error", reject);
    child.on("close", (code, signalName) => {
      if (timer) clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      const exitCode = code ?? (signalName ? 128 : 1);
      if (exitCode === 0 && opts.engine === "codex" && opts.outputSchema && !hasStructuredOutput) {
        const parsed = parseJsonText(stdout.join("\n"));
        if (parsed.ok) {
          structuredOutput = parsed.value;
          hasStructuredOutput = true;
        }
      }
      const structuredError =
        exitCode === 0 && opts.outputSchema && !hasStructuredOutput
          ? missingStructuredOutputError(opts.engine)
          : undefined;
      const finalExitCode = structuredError ? 1 : exitCode;
      resolve({
        exitCode: finalExitCode,
        error:
          finalExitCode === 0 ? undefined : (structuredError ?? failurePreview(exitCode, signalName, stderr, stdout)),
        sessionId,
        usage,
        model,
        structuredOutput: hasStructuredOutput ? structuredOutput : undefined,
      });
    });
  });
}

class ClaudeSession implements EngineSession {
  private readonly child: ReturnType<typeof spawn>;
  private outBuf = "";
  private pending: {
    resolve: (result: EngineResult) => void;
    stdout: string[];
    stderr: string[];
    timer: NodeJS.Timeout | null;
    noOutputTimer: NodeJS.Timeout | null;
  } | null = null;
  private exited = false;
  private exitCode = 0;
  private sid: string | null = null;
  private currentModel: string | null = null;
  private stderrTail: string[] = [];
  private stdoutTail: string[] = [];
  private steerQueue: string[] = [];

  constructor(
    bin: string,
    args: string[],
    opts: Omit<EngineRunArgs, "prompt" | "signal"> & { shell?: boolean; stdinText?: string },
    readonly carriesStandingPrompt: boolean,
  ) {
    this.child = spawn(bin, args, {
      cwd: opts.home,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: opts.shell ?? false,
    });
    this.child.stdout?.on("data", (buf) => this.onStdout(buf, opts.onLog));
    this.child.stderr?.on("data", (buf) => this.onStderr(buf, opts.onLog));
    this.child.on("error", (err) => this.die(1, err.message));
    this.child.on("close", (code, signalName) =>
      this.die(
        code ?? (signalName ? 128 : 1),
        signalName ? `terminated by ${signalName}` : `exited with code ${code ?? 1}`,
      ),
    );
    if (opts.stdinText) this.child.stdin?.write(opts.stdinText);
  }

  get alive(): boolean {
    return !this.exited && this.child.stdin?.writable === true;
  }

  get sessionId(): string | null {
    return this.sid;
  }

  send(prompt: string, options?: EngineTurnOptions): Promise<EngineResult> {
    if (options?.outputSchema) {
      return Promise.resolve({
        exitCode: 1,
        error: "claude structured output requires a one-shot engine turn",
        sessionId: this.sid,
      });
    }
    if (this.pending)
      return Promise.resolve({ exitCode: 1, error: "engine session is already running a turn", sessionId: this.sid });
    if (!this.alive) {
      const exitCode = this.exitCode || 1;
      const detail = failurePreview(exitCode, null, this.stderrTail, this.stdoutTail);
      return Promise.resolve({ exitCode, error: detail || "engine session is not alive", sessionId: this.sid });
    }
    return new Promise((resolve) => {
      const pending = {
        resolve,
        stdout: [] as string[],
        stderr: [] as string[],
        timer: null as NodeJS.Timeout | null,
        noOutputTimer: null as NodeJS.Timeout | null,
      };
      const timeoutMs = sessionTimeoutMs();
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.settle({
            exitCode: 124,
            error: `claude engine turn exceeded KING_AI_SESSION_TIMEOUT_MS (${Math.round(timeoutMs / 1000)}s) - aborted; session will respawn`,
            sessionId: this.sid,
          });
          this.stop();
        }, timeoutMs);
        pending.timer.unref?.();
      }
      this.resetNoOutputTimer(pending);
      this.pending = pending;
      this.child.stdin?.write(claudeStreamUserMessage(prompt));
    });
  }

  steer(text: string): void {
    if (!this.pending || !this.alive || !text.trim()) return;
    this.steerQueue.push(text);
  }

  stop(): void {
    this.exited = true;
    this.child.stdin?.end();
    this.child.kill("SIGTERM");
  }

  private onStdout(buf: Buffer, onLog: (line: string) => void): void {
    this.outBuf += buf.toString("utf8");
    let nl: number;
    while ((nl = this.outBuf.indexOf("\n")) >= 0) {
      const line = cleanLine(this.outBuf.slice(0, nl));
      this.outBuf = this.outBuf.slice(nl + 1);
      if (!line) continue;
      pushTail(this.stdoutTail, line);
      if (this.pending) pushTail(this.pending.stdout, line);
      const display = formatEngineLogLine("claude", line);
      if (display) onLog(display);
      this.resetNoOutputTimer();
      if (!line.startsWith("{")) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (typeof obj.session_id === "string") this.sid = obj.session_id;
        if (typeof obj.model === "string") this.currentModel = obj.model;
        const message = obj.message as { model?: unknown } | undefined;
        if (typeof message?.model === "string") this.currentModel = message.model;
        if (obj.type === "result") {
          this.steerQueue = [];
          const isError = obj.is_error === true;
          const detail = failurePreview(1, null, this.pending?.stderr ?? [], this.pending?.stdout ?? []);
          const resultText = String(obj.result ?? "").trim();
          this.settle({
            exitCode: isError ? 1 : 0,
            error: isError
              ? (resultText && resultText !== "error" ? resultText : detail || "engine turn error").slice(
                  0,
                  MAX_FAILURE_CHARS,
                )
              : undefined,
            sessionId: this.sid,
            usage: obj.usage && typeof obj.usage === "object" ? (obj.usage as EngineUsage) : undefined,
            model: this.currentModel,
          });
        } else if (obj.type === "user") {
          this.flushSteer();
        }
      } catch {
        // Ignore malformed event JSON.
      }
    }
  }

  private onStderr(buf: Buffer, onLog: (line: string) => void): void {
    for (const raw of buf.toString("utf8").split("\n")) {
      const line = cleanLine(raw);
      if (!line) continue;
      pushTail(this.stderrTail, line);
      if (this.pending) pushTail(this.pending.stderr, line);
      onLog(line);
      this.resetNoOutputTimer();
    }
  }

  private flushSteer(): void {
    if (!this.pending || !this.alive) return;
    while (this.steerQueue.length > 0) {
      const text = this.steerQueue.shift();
      if (!text) continue;
      try {
        this.child.stdin?.write(claudeStreamUserMessage(text));
      } catch {
        break;
      }
    }
  }

  private settle(result: EngineResult): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.noOutputTimer) clearTimeout(pending.noOutputTimer);
    pending.resolve(result);
  }

  private resetNoOutputTimer(pending = this.pending): void {
    if (!pending) return;
    if (pending.noOutputTimer) clearTimeout(pending.noOutputTimer);
    const timeoutMs = sessionNoOutputTimeoutMs();
    if (timeoutMs <= 0) {
      pending.noOutputTimer = null;
      return;
    }
    pending.noOutputTimer = setTimeout(() => {
      this.settle({
        exitCode: 124,
        error: engineNoOutputError("claude", timeoutMs),
        sessionId: this.sid,
      });
      this.stop();
    }, timeoutMs);
    pending.noOutputTimer.unref?.();
  }

  private die(exitCode: number, error: string): void {
    this.exited = true;
    this.exitCode = exitCode;
    const pending = this.pending;
    if (!pending) return;
    const detail = failurePreview(exitCode, null, pending.stderr, pending.stdout);
    this.settle({ exitCode, error: detail || error, sessionId: this.sid });
  }
}

function ensureGitRepoForCodex(home: string): void {
  if (existsSync(join(home, ".git"))) return;
  const gitEnv = { cwd: home, stdio: "ignore" as const };
  const identity = ["-c", "user.name=king-ai", "-c", "user.email=king-ai@local", "-c", "commit.gpgsign=false"];
  execFileSync("git", ["init"], gitEnv);
  execFileSync("git", [...identity, "commit", "--allow-empty", "-m", "king-ai init"], gitEnv);
}

class CodexSession implements EngineSession {
  private readonly child: ReturnType<typeof spawn>;
  private outBuf = "";
  private reqId = 0;
  private initializeId: number | null = null;
  private threadReqId: number | null = null;
  private turnStart = { input: 0, cached: 0, output: 0 };
  private usage = { input: 0, cached: 0, output: 0 };
  private pending: {
    resolve: (result: EngineResult) => void;
    timer: NodeJS.Timeout | null;
    noOutputTimer: NodeJS.Timeout | null;
    sawOutput: boolean;
    outputSchema?: JsonSchema;
    agentMessage?: string;
  } | null = null;
  private queuedTurn: { prompt: string; options?: EngineTurnOptions } | null = null;
  private ready = false;
  private exited = false;
  private exitCode = 0;
  private threadId: string | null = null;
  private threadWasResume = false;
  private activeTurnId: string | null = null;
  private steerGate = false;
  private stderrTail: string[] = [];
  private stdoutTail: string[] = [];
  readonly carriesStandingPrompt: boolean;

  constructor(
    bin: string,
    args: string[],
    private readonly opts: Omit<EngineRunArgs, "prompt" | "signal">,
  ) {
    this.threadId = opts.resumeSessionId ?? null;
    this.carriesStandingPrompt = !!opts.standingPrompt;
    this.child = spawn(bin, args, { cwd: opts.home, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout?.on("data", (buf) => this.onStdout(buf));
    this.child.stderr?.on("data", (buf) => {
      for (const raw of buf.toString("utf8").split("\n")) {
        const line = cleanLine(raw);
        if (!line) continue;
        pushTail(this.stderrTail, line);
        opts.onLog(line);
      }
    });
    this.child.on("error", (err) => this.die(1, err.message));
    this.child.on("close", (code, sig) =>
      this.die(code ?? (sig ? 128 : 1), sig ? `terminated by ${sig}` : `exited with code ${code ?? 1}`),
    );
    queueMicrotask(() => {
      this.initializeId = this.req("initialize", {
        clientInfo: { name: "king-ai", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
    });
  }

  get alive(): boolean {
    return !this.exited && this.child.stdin?.writable === true;
  }

  get sessionId(): string | null {
    return this.threadId;
  }

  send(prompt: string, options?: EngineTurnOptions): Promise<EngineResult> {
    if (this.pending)
      return Promise.resolve({
        exitCode: 1,
        error: "engine session is already running a turn",
        sessionId: this.threadId,
      });
    if (!this.alive) {
      const exitCode = this.exitCode || 1;
      return Promise.resolve({
        exitCode,
        error: failurePreview(exitCode, null, this.stderrTail, this.stdoutTail),
        sessionId: this.threadId,
      });
    }
    return new Promise((resolve) => {
      const pending = {
        resolve,
        timer: null as NodeJS.Timeout | null,
        noOutputTimer: null as NodeJS.Timeout | null,
        sawOutput: false,
        outputSchema: options?.outputSchema,
        agentMessage: undefined as string | undefined,
      };
      const timeoutMs = sessionTimeoutMs();
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.stop();
          this.settle(
            `codex engine turn exceeded KING_AI_SESSION_TIMEOUT_MS (${Math.round(timeoutMs / 1000)}s) - aborted; session will respawn`,
            124,
          );
        }, timeoutMs);
        pending.timer.unref?.();
      }
      this.resetNoOutputTimer(pending);
      this.pending = pending;
      this.turnStart = { ...this.usage };
      if (this.ready && this.threadId) this.startTurn(prompt, options);
      else this.queuedTurn = { prompt, options };
    });
  }

  steer(text: string): void {
    if (!this.threadId || !this.activeTurnId || this.steerGate || !this.alive || !text.trim()) return;
    this.req("turn/steer", {
      threadId: this.threadId,
      expectedTurnId: this.activeTurnId,
      input: codexUserInput(text),
    });
  }

  stop(): void {
    this.exited = true;
    this.child.stdin?.end();
    this.child.kill("SIGTERM");
  }

  private nextId(): number {
    this.reqId += 1;
    return this.reqId;
  }

  private req(method: string, params: unknown): number {
    const id = this.nextId();
    this.child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return id;
  }

  private notify(method: string, params: unknown): void {
    this.child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  private threadParams(): Record<string, unknown> {
    return {
      cwd: this.opts.home,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      experimentalRawEvents: true,
      ...(this.opts.standingPrompt ? { developerInstructions: this.opts.standingPrompt } : {}),
      ...(this.opts.model ? { model: this.opts.model } : {}),
    };
  }

  private startThread(): void {
    const params = this.threadParams();
    this.threadWasResume = !!this.threadId;
    this.threadReqId = this.threadId
      ? this.req("thread/resume", { threadId: this.threadId, ...params })
      : this.req("thread/start", params);
  }

  private startTurn(prompt: string, options?: EngineTurnOptions): void {
    if (!this.threadId) return;
    this.req("turn/start", {
      threadId: this.threadId,
      input: codexUserInput(prompt, options?.imagePaths),
      ...(options?.outputSchema ? { outputSchema: options.outputSchema } : {}),
    });
  }

  private onStdout(buf: Buffer): void {
    this.outBuf += buf.toString("utf8");
    let nl: number;
    while ((nl = this.outBuf.indexOf("\n")) >= 0) {
      const raw = this.outBuf.slice(0, nl);
      this.outBuf = this.outBuf.slice(nl + 1);
      const line = cleanLine(raw);
      if (!line) continue;
      pushTail(this.stdoutTail, line);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.opts.onLog(line);
        this.noteOutput();
        continue;
      }
      if (process.env.KING_AI_CODEX_VERBOSE === "1") this.opts.onLog(line);
      this.handle(msg);
    }
  }

  private handle(msg: Record<string, unknown>): void {
    if (msg.id === this.initializeId) {
      this.initializeId = null;
      if (msg.error) return this.settle(errorMessage(msg.error, "codex initialize failed"));
      this.notify("initialized", {});
      this.startThread();
      return;
    }
    if (msg.id === this.threadReqId && msg.error) {
      if (this.threadWasResume) {
        this.opts.onLog(
          `[codex] thread/resume failed (${errorMessage(msg.error, "unknown error")}) - starting a fresh thread`,
        );
        this.threadId = null;
        this.threadWasResume = false;
        this.startThread();
        return;
      }
      this.threadReqId = null;
      this.settle(errorMessage(msg.error, "codex thread start failed"));
      return;
    }
    const method = typeof msg.method === "string" ? msg.method : "";
    if (method === "error") {
      this.settle(errorMessage(msg.params, "codex app-server error"));
      return;
    }
    if (msg.error) {
      this.settle(errorMessage(msg.error, "codex app-server error"));
      return;
    }

    const reduced = reduceCodexAppEvent({ activeTurnId: this.activeTurnId, steerGate: this.steerGate }, msg);
    for (const line of reduced.logs) {
      this.opts.onLog(line);
      this.noteOutput();
    }
    this.activeTurnId = reduced.activeTurnId;
    this.steerGate = reduced.steerGate;
    if (reduced.agentMessage && this.pending) this.pending.agentMessage = reduced.agentMessage;
    if (reduced.usage) this.updateUsage(reduced.usage);
    if (reduced.threadId) {
      this.threadId = reduced.threadId;
      this.threadReqId = null;
      this.threadWasResume = false;
      this.ready = true;
      if (this.queuedTurn && this.pending) {
        const queued = this.queuedTurn;
        this.queuedTurn = null;
        this.startTurn(queued.prompt, queued.options);
      }
    }
    if (method === "turn/completed") {
      this.settle(reduced.turnCompletedError);
    }
  }

  private updateUsage(total: unknown): void {
    if (!total || typeof total !== "object") return;
    const rec = total as Record<string, unknown>;
    const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    this.usage = {
      input: Math.max(this.usage.input, num(rec.inputTokens)),
      cached: Math.max(this.usage.cached, num(rec.cachedInputTokens)),
      output: Math.max(this.usage.output, num(rec.outputTokens) + num(rec.reasoningOutputTokens)),
    };
  }

  private turnUsage(): EngineUsage {
    const inputTotal = Math.max(0, this.usage.input - this.turnStart.input);
    const cached = Math.max(0, this.usage.cached - this.turnStart.cached);
    return {
      input_tokens: Math.max(0, inputTotal - cached),
      cache_read_input_tokens: cached,
      output_tokens: Math.max(0, this.usage.output - this.turnStart.output),
    };
  }

  private settle(error?: string, exitCode = error ? 1 : 0): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.noOutputTimer) clearTimeout(pending.noOutputTimer);
    const parsed = pending.outputSchema ? parseJsonText(pending.agentMessage ?? "") : { ok: false as const };
    const structuredError = pending.outputSchema && !parsed.ok ? missingStructuredOutputError("codex") : undefined;
    const finalError = error ?? structuredError;
    pending.resolve({
      exitCode: finalError ? exitCode || 1 : exitCode,
      error: finalError,
      sessionId: this.threadId,
      usage: this.turnUsage(),
      model: this.opts.model ?? null,
      structuredOutput: parsed.ok ? parsed.value : undefined,
    });
  }

  private noteOutput(): void {
    const pending = this.pending;
    if (!pending) return;
    pending.sawOutput = true;
    if (pending.noOutputTimer) {
      clearTimeout(pending.noOutputTimer);
      pending.noOutputTimer = null;
    }
  }

  private resetNoOutputTimer(pending = this.pending): void {
    if (!pending || pending.sawOutput) return;
    if (pending.noOutputTimer) clearTimeout(pending.noOutputTimer);
    const timeoutMs = sessionNoOutputTimeoutMs();
    if (timeoutMs <= 0) {
      pending.noOutputTimer = null;
      return;
    }
    pending.noOutputTimer = setTimeout(() => {
      this.stop();
      this.settle(engineNoOutputError("codex", timeoutMs), 124);
    }, timeoutMs);
    pending.noOutputTimer.unref?.();
  }

  private die(exitCode: number, error: string): void {
    this.exited = true;
    this.exitCode = exitCode;
    const detail = failurePreview(exitCode, null, this.stderrTail, this.stdoutTail);
    this.settle(detail || error, exitCode);
  }
}

class ClaudeAdapter implements EngineAdapter {
  id: EngineId = "claude";
  bin = "claude";

  async seedHome(home: string, persona: { id: string; name: string; role?: string }): Promise<void> {
    await ensureCommonHome(home);
    await mkdir(join(home, ".claude", "skills"), { recursive: true });
    await seedPersonaFile(join(home, "CLAUDE.md"), persona);
  }

  async classify(args: EngineClassifyArgs): Promise<{ text: string; error?: string; usage?: EngineUsage }> {
    const extra = envExtraArgs("KING_AI_TRIAGE_ARGS");
    const model = ["--model", args.model || "haiku"];
    const { command, shell, wantsStdinPrompt } = resolveSpawn(this.bin);
    const usingJson = extra.length === 0;
    const base = extra.length
      ? [...extra, "-p"]
      : ["-p", ...model, "--output-format", "json", "--dangerously-skip-permissions", "--strict-mcp-config"];
    const argv = wantsStdinPrompt
      ? base
      : extra.length
        ? [...base, args.prompt]
        : ["-p", args.prompt, ...base.slice(1)];
    const res = await spawnCapture(command, argv, {
      cwd: args.cwd,
      env: { ...args.env, MAX_THINKING_TOKENS: "0" },
      signal: args.signal,
      shell,
      stdinText: wantsStdinPrompt ? args.prompt : undefined,
      onLog: args.onLog,
    });
    if (res.error || !usingJson) return res;
    try {
      const parsed = JSON.parse(res.text) as { result?: string; usage?: EngineUsage };
      return { text: parsed.result ?? res.text, usage: parsed.usage };
    } catch {
      return res;
    }
  }

  probe(args: EngineProbeArgs): Promise<{ text: string; error?: string }> {
    const model = args.tier === "small" ? ["--model", "haiku"] : [];
    const { command, shell, wantsStdinPrompt } = resolveSpawn(this.bin);
    const base = ["-p", ...model, "--output-format", "text", "--dangerously-skip-permissions", "--strict-mcp-config"];
    const argv = wantsStdinPrompt ? base : ["-p", DOCTOR_PROMPT, ...base.slice(1)];
    return spawnCapture(command, argv, {
      cwd: args.cwd,
      env: { ...args.env, MAX_THINKING_TOKENS: "0" },
      signal: args.signal,
      shell,
      stdinText: wantsStdinPrompt ? DOCTOR_PROMPT : undefined,
    });
  }

  run(args: EngineRunArgs): Promise<EngineResult> {
    const extra = envExtraArgs("KING_AI_CLAUDE_ARGS");
    const model = args.model ? ["--model", args.model] : [];
    const resume = args.resumeSessionId ? ["--resume", args.resumeSessionId] : [];
    const output = args.outputSchema
      ? ["--output-format", "json", "--json-schema", JSON.stringify(args.outputSchema)]
      : ["--output-format", "stream-json", "--verbose"];
    const { command, shell, wantsStdinPrompt } = resolveSpawn(this.bin);
    const base = extra.length
      ? [...extra, ...resume, ...(args.outputSchema ? output : []), "-p"]
      : ["-p", ...resume, ...model, ...output, "--dangerously-skip-permissions"];
    const argv = wantsStdinPrompt
      ? base
      : extra.length
        ? [...base, args.prompt]
        : ["-p", args.prompt, ...base.slice(1)];
    const env: NodeJS.ProcessEnv = { ...args.env, MAX_THINKING_TOKENS: args.env.MAX_THINKING_TOKENS ?? "0" };
    if (args.fastModel) env.ANTHROPIC_SMALL_FAST_MODEL = args.fastModel;
    return spawnEngine(command, argv, {
      ...args,
      engine: this.id,
      env,
      shell,
      stdinText: wantsStdinPrompt ? args.prompt : undefined,
    });
  }

  startSession(args: Omit<EngineRunArgs, "prompt" | "signal">): EngineSession | null {
    if (IS_WIN || envExtraArgs("KING_AI_CLAUDE_ARGS").length) return null;
    const model = args.model ? ["--model", args.model] : [];
    const resume = args.resumeSessionId ? ["--resume", args.resumeSessionId] : [];
    const standingFile = join(args.home, ".king-ai-standing-prompt.md");
    let systemPrompt: string[] = [];
    let carriesStandingPrompt = false;
    if (args.standingPrompt) {
      try {
        writeFileSync(standingFile, args.standingPrompt, { mode: 0o600 });
        systemPrompt = ["--append-system-prompt-file", standingFile];
        carriesStandingPrompt = true;
      } catch {
        systemPrompt = [];
      }
    }
    const argv = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      ...resume,
      ...systemPrompt,
      ...model,
      "--dangerously-skip-permissions",
    ];
    const env: NodeJS.ProcessEnv = { ...args.env, MAX_THINKING_TOKENS: args.env.MAX_THINKING_TOKENS ?? "0" };
    if (args.fastModel) env.ANTHROPIC_SMALL_FAST_MODEL = args.fastModel;
    return new ClaudeSession(this.bin, argv, { ...args, env }, carriesStandingPrompt);
  }
}

class CodexAdapter implements EngineAdapter {
  id: EngineId = "codex";
  bin = "codex";

  async seedHome(home: string, persona: { id: string; name: string; role?: string }): Promise<void> {
    await ensureCommonHome(home);
    await seedPersonaFile(join(home, "AGENTS.md"), persona);
  }

  classify(args: EngineClassifyArgs): Promise<{ text: string; error?: string }> {
    const extra = envExtraArgs("KING_AI_TRIAGE_ARGS");
    const model = ["--model", args.model || "gpt-5.4-mini"];
    const { command, shell } = resolveSpawn(this.bin);
    const argv = extra.length
      ? ["exec", ...extra, args.prompt]
      : ["exec", ...model, "--skip-git-repo-check", args.prompt];
    return spawnCapture(command, argv, {
      cwd: args.cwd,
      env: args.env,
      signal: args.signal,
      shell,
      onLog: args.onLog,
    });
  }

  probe(args: EngineProbeArgs): Promise<{ text: string; error?: string }> {
    const model = args.tier === "small" ? ["--model", "gpt-5.4-mini"] : [];
    const { command, shell } = resolveSpawn(this.bin);
    return spawnCapture(command, ["exec", ...model, "--skip-git-repo-check", DOCTOR_PROMPT], {
      cwd: args.cwd,
      env: args.env,
      signal: args.signal,
      shell,
    });
  }

  async run(args: EngineRunArgs): Promise<EngineResult> {
    const extra = envExtraArgs("KING_AI_CODEX_ARGS");
    const model = args.model ? ["--model", args.model] : [];
    const { command, shell } = resolveSpawn(this.bin);
    const base = extra.length ? extra : ["--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"];
    const output: string[] = [];
    if (args.outputSchema) {
      const schemaPath = join(args.home, ".king-ai-output-schema.json");
      await writeFile(schemaPath, JSON.stringify(args.outputSchema), { mode: 0o600 });
      output.push("--output-schema", schemaPath);
    }
    return spawnEngine(
      command,
      ["exec", ...model, ...codexImageArgs(args.imagePaths), ...output, ...base, args.prompt],
      {
        ...args,
        engine: this.id,
        shell,
      },
    );
  }

  startSession(args: Omit<EngineRunArgs, "prompt" | "signal">): EngineSession | null {
    if (IS_WIN || envExtraArgs("KING_AI_CODEX_ARGS").length || process.env.KING_AI_CODEX_NO_APP_SERVER === "1")
      return null;
    try {
      ensureGitRepoForCodex(args.home);
    } catch (err) {
      args.onLog(
        `[codex] could not initialize git repo for app-server: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    return new CodexSession(this.bin, ["app-server", "--listen", "stdio://"], args);
  }
}

const GROK_SMALL_MODEL = "grok-composer-2.5-fast";

function grokUsageFromMeta(meta: Record<string, unknown> | undefined): EngineUsage | undefined {
  if (!meta) return undefined;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const inputTokens = num(meta.inputTokens);
  const cached = num(meta.cachedReadTokens);
  const output = num(meta.outputTokens) + num(meta.reasoningTokens);
  if (!inputTokens && !cached && !output) return undefined;
  return {
    input_tokens: Math.max(0, inputTokens - cached),
    cache_read_input_tokens: cached,
    output_tokens: output,
  };
}

function grokUsageFromResult(value: unknown): EngineUsage | undefined {
  const usage = unknownRecord(value);
  if (!usage) return undefined;
  const num = (key: string) =>
    typeof usage[key] === "number" && Number.isFinite(usage[key]) ? (usage[key] as number) : 0;
  const input = num("input_tokens");
  const cached = num("cache_read_input_tokens");
  const output = num("output_tokens") + num("reasoning_tokens");
  if (!input && !cached && !output) return undefined;
  return { input_tokens: input, cache_read_input_tokens: cached, output_tokens: output };
}

type GrokPromptBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function grokImageMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/png";
}

async function grokImageBlocks(imagePaths: readonly string[]): Promise<GrokPromptBlock[]> {
  const blocks: GrokPromptBlock[] = [];
  for (const rawPath of imagePaths.filter((path) => path.trim())) {
    const bytes = await readFile(rawPath);
    blocks.push({
      type: "image",
      data: bytes.toString("base64"),
      mimeType: grokImageMimeType(rawPath),
    });
  }
  return blocks;
}

async function grokHeadlessArgv(args: {
  home: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  resumeSessionId?: string | null;
  standingPrompt?: string;
  outputFormat: "json" | "streaming-json" | "plain";
  imagePaths?: readonly string[];
  outputSchema?: JsonSchema;
}): Promise<string[]> {
  const extra = envExtraArgs("KING_AI_GROK_ARGS");
  const model = args.model ? ["-m", args.model] : [];
  const reasoningEffort = args.reasoningEffort?.trim() ? ["--reasoning-effort", args.reasoningEffort.trim()] : [];
  const resume = args.resumeSessionId ? ["--resume", args.resumeSessionId] : [];
  const rules = args.standingPrompt && !args.resumeSessionId ? ["--rules", args.standingPrompt] : [];
  const base = [
    "--no-auto-update",
    "--always-approve",
    "--no-alt-screen",
    "--cwd",
    args.home,
    ...model,
    ...reasoningEffort,
    ...extra,
    ...rules,
    ...resume,
  ];
  const imagePaths = (args.imagePaths ?? []).filter((path) => path.trim());
  const structured = args.outputSchema ? ["--json-schema", JSON.stringify(args.outputSchema)] : [];
  if (imagePaths.length > 0) {
    const blocks: GrokPromptBlock[] = [
      ...(await grokImageBlocks(imagePaths)),
      { type: "text", text: stripLoneSurrogates(args.prompt) },
    ];
    return [...base, ...structured, "--prompt-json", JSON.stringify(blocks), "--output-format", args.outputFormat];
  }
  return [...base, ...structured, "-p", args.prompt, "--output-format", args.outputFormat];
}

export function grokTurnFromStdout(stdout: string, model?: string | null): EngineResult {
  try {
    const obj = JSON.parse(stripLoneSurrogates(stdout).trim()) as Record<string, unknown>;
    const modelUsage = unknownRecord(obj.modelUsage);
    const resolvedModel =
      typeof obj.modelId === "string" ? obj.modelId : (Object.keys(modelUsage ?? {})[0] ?? model ?? null);
    const stopReason = typeof obj.stopReason === "string" ? obj.stopReason : "";
    const error =
      obj.type === "error" || stopReason.toLowerCase().includes("error")
        ? String(obj.message ?? `grok turn failed: ${stopReason || "error"}`).slice(0, MAX_FAILURE_CHARS)
        : undefined;
    return {
      exitCode: error ? 1 : 0,
      error,
      sessionId: typeof obj.sessionId === "string" ? obj.sessionId : null,
      usage: grokUsageFromResult(obj.usage) ?? grokUsageFromMeta(unknownRecord(obj._meta) ?? undefined),
      model: resolvedModel,
      structuredOutput: Object.hasOwn(obj, "structuredOutput") ? obj.structuredOutput : undefined,
    };
  } catch {
    // Streaming mode emits multiple JSON values, handled below.
  }
  let sessionId: string | null = null;
  let usage: EngineUsage | undefined;
  let resolvedModel = model ?? null;
  let error: string | undefined;
  let structuredOutput: unknown;
  let hasStructuredOutput = false;
  for (const raw of stdout.split("\n")) {
    const line = cleanLine(raw);
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj.type === "error") {
        error = String(obj.message ?? "grok turn failed").slice(0, MAX_FAILURE_CHARS);
        continue;
      }
      if (obj.type === "end") {
        if (typeof obj.sessionId === "string") sessionId = obj.sessionId;
        if (!error && typeof obj.stopReason === "string" && obj.stopReason.toLowerCase().includes("error")) {
          error = `grok turn failed: ${obj.stopReason}`;
        }
        // Streaming structured turns put the final payload on the end event.
        if (Object.hasOwn(obj, "structuredOutput")) {
          structuredOutput = obj.structuredOutput;
          hasStructuredOutput = true;
        }
        usage = grokUsageFromResult(obj.usage) ?? usage;
        const modelUsage = unknownRecord(obj.modelUsage);
        if (typeof obj.modelId === "string") resolvedModel = obj.modelId;
        else if (modelUsage) {
          const modelKey = Object.keys(modelUsage)[0];
          if (modelKey) resolvedModel = modelKey;
        }
        continue;
      }
      const meta = obj._meta as Record<string, unknown> | undefined;
      if (meta) {
        if (typeof meta.sessionId === "string") sessionId = meta.sessionId;
        if (typeof meta.modelId === "string") resolvedModel = meta.modelId;
        usage = grokUsageFromMeta(meta) ?? usage;
      }
      if (typeof obj.sessionId === "string") sessionId = obj.sessionId;
      if (typeof obj.modelId === "string") resolvedModel = obj.modelId;
      if (Object.hasOwn(obj, "structuredOutput")) {
        structuredOutput = obj.structuredOutput;
        hasStructuredOutput = true;
      }
    } catch {
      // Ignore malformed event JSON.
    }
  }
  if (!error && !sessionId && !stdout.trim()) error = "grok produced no output";
  return {
    exitCode: error ? 1 : 0,
    error,
    sessionId,
    usage,
    model: resolvedModel,
    structuredOutput: hasStructuredOutput ? structuredOutput : undefined,
  };
}

function spawnGrokTurn(
  bin: string,
  argv: string[],
  opts: {
    home: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    onLog: (line: string) => void;
    onOutput?: () => void;
    shell?: boolean;
    model?: string | null;
    outputSchema?: JsonSchema;
  },
): Promise<EngineResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, {
      cwd: opts.home,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: opts.shell ?? false,
    });
    const stderr: string[] = [];
    const stdout: string[] = [];
    let timer: NodeJS.Timeout | null = null;
    const onAbort = () => child.kill("SIGTERM");
    opts.signal.addEventListener("abort", onAbort, { once: true });
    const timeoutMs = turnTimeoutMs();
    if (timeoutMs > 0) timer = setTimeout(onAbort, timeoutMs);

    const grokLog = createGrokLogSink(opts.onLog);
    child.stdout?.on("data", (buf) => {
      opts.onOutput?.();
      const text = buf.toString("utf8");
      stdout.push(text);
      for (const raw of text.split("\n")) {
        const line = cleanLine(raw);
        if (line) grokLog(line);
      }
    });
    child.stderr?.on("data", (buf) => {
      for (const raw of buf.toString("utf8").split("\n")) {
        const line = cleanLine(raw);
        if (line) stderr.push(line);
      }
    });
    child.on("error", reject);
    child.on("close", (code, signalName) => {
      if (timer) clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      const exitCode = code ?? (signalName ? 128 : 1);
      const merged = stdout.join("");
      const parsed = grokTurnFromStdout(merged, opts.model);
      if (exitCode === 0 && opts.outputSchema && parsed.structuredOutput === undefined) {
        parsed.exitCode = 1;
        parsed.error = missingStructuredOutputError("grok");
      }
      if (exitCode !== 0 && !parsed.error) {
        parsed.exitCode = exitCode;
        parsed.error = failurePreview(exitCode, signalName, stderr, merged.split("\n").map(cleanLine).filter(Boolean));
      }
      resolve(parsed);
    });
  });
}

class GrokSession implements EngineSession {
  private pending: Promise<EngineResult> | null = null;
  private exited = false;
  private sid: string | null;
  readonly carriesStandingPrompt: boolean;

  constructor(
    private readonly bin: string,
    private readonly opts: Omit<EngineRunArgs, "prompt" | "signal">,
    standingPrompt?: string,
  ) {
    this.sid = opts.resumeSessionId ?? null;
    this.carriesStandingPrompt = !!standingPrompt;
    this.opts = { ...opts, standingPrompt };
  }

  get alive(): boolean {
    return !this.exited;
  }

  get sessionId(): string | null {
    return this.sid;
  }

  send(prompt: string, options?: EngineTurnOptions): Promise<EngineResult> {
    if (this.pending)
      return Promise.resolve({ exitCode: 1, error: "engine session is already running a turn", sessionId: this.sid });
    if (!this.alive) return Promise.resolve({ exitCode: 1, error: "engine session is not alive", sessionId: this.sid });
    const controller = new AbortController();
    const timeoutMs = sessionTimeoutMs();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    timer?.unref?.();
    const noOutputMs = sessionNoOutputTimeoutMs();
    let noOutputTimer: NodeJS.Timeout | null = null;
    let sawOutput = false;
    const resetNoOutputTimer = () => {
      if (noOutputTimer) clearTimeout(noOutputTimer);
      if (noOutputMs <= 0 || sawOutput) {
        noOutputTimer = null;
        return;
      }
      noOutputTimer = setTimeout(() => controller.abort(), noOutputMs);
      noOutputTimer.unref?.();
    };

    const runOnce = async (resumeSessionId: string | null, standingPrompt?: string): Promise<EngineResult> => {
      const { command, shell } = resolveSpawn(this.bin);
      const argv = await grokHeadlessArgv({
        home: this.opts.home,
        prompt,
        model: this.opts.model,
        reasoningEffort: this.opts.reasoningEffort,
        resumeSessionId,
        standingPrompt,
        // Always stream so structured turns still emit thought/text deltas for the activity feed.
        outputFormat: "streaming-json",
        imagePaths: options?.imagePaths,
        outputSchema: options?.outputSchema,
      });
      return spawnGrokTurn(command, argv, {
        home: this.opts.home,
        env: this.opts.env,
        signal: controller.signal,
        shell,
        model: this.opts.model ?? null,
        outputSchema: options?.outputSchema,
        onOutput: () => {
          sawOutput = true;
          if (noOutputTimer) {
            clearTimeout(noOutputTimer);
            noOutputTimer = null;
          }
        },
        onLog: this.opts.onLog,
      });
    };

    this.pending = (async () => {
      resetNoOutputTimer();
      let result = await runOnce(this.sid, this.carriesStandingPrompt ? this.opts.standingPrompt : undefined);
      if (result.error && this.sid && /session does not exist/i.test(result.error)) {
        this.opts.onLog(`[grok] session/resume failed (${result.error}) - starting a fresh session`);
        this.sid = null;
        result = await runOnce(null, this.carriesStandingPrompt ? this.opts.standingPrompt : undefined);
      }
      if (result.sessionId) this.sid = result.sessionId;
      if (!sawOutput && !result.error) {
        result = {
          exitCode: 124,
          error: engineNoOutputError("grok", noOutputMs),
          sessionId: this.sid,
        };
        this.exited = true;
      }
      return result;
    })().finally(() => {
      if (timer) clearTimeout(timer);
      if (noOutputTimer) clearTimeout(noOutputTimer);
      this.pending = null;
    });
    return this.pending;
  }

  steer(_text: string): void {
    // Grok headless sessions do not expose mid-turn steering.
  }

  stop(): void {
    this.exited = true;
  }
}

class GrokAdapter implements EngineAdapter {
  id: EngineId = "grok";
  bin = "grok";

  async seedHome(home: string, persona: { id: string; name: string; role?: string }): Promise<void> {
    await ensureCommonHome(home);
    await mkdir(join(home, ".grok", "skills"), { recursive: true });
    await seedPersonaFile(join(home, "AGENTS.md"), persona);
  }

  async classify(args: EngineClassifyArgs): Promise<{ text: string; error?: string; usage?: EngineUsage }> {
    const { command, shell } = resolveSpawn(this.bin);
    const argv = await grokHeadlessArgv({
      home: args.cwd,
      prompt: args.prompt,
      model: args.model || GROK_SMALL_MODEL,
      outputFormat: "json",
    });
    const res = await spawnCapture(command, argv, {
      cwd: args.cwd,
      env: args.env,
      signal: args.signal,
      shell,
      onLog: args.onLog,
    });
    if (res.error) return res;
    try {
      const parsed = JSON.parse(res.text) as { text?: string; _meta?: Record<string, unknown> };
      return { text: parsed.text ?? res.text, usage: grokUsageFromMeta(parsed._meta) };
    } catch {
      return res;
    }
  }

  probe(args: EngineProbeArgs): Promise<{ text: string; error?: string }> {
    const model = args.tier === "small" ? ["-m", GROK_SMALL_MODEL] : [];
    const { command, shell } = resolveSpawn(this.bin);
    const argv = [
      "--no-auto-update",
      "--always-approve",
      "--no-alt-screen",
      "--cwd",
      args.cwd,
      ...model,
      ...envExtraArgs("KING_AI_GROK_ARGS"),
      "-p",
      DOCTOR_PROMPT,
      "--output-format",
      "plain",
    ];
    return spawnCapture(command, argv, {
      cwd: args.cwd,
      env: args.env,
      signal: args.signal,
      shell,
    });
  }

  async run(args: EngineRunArgs): Promise<EngineResult> {
    const { command, shell } = resolveSpawn(this.bin);
    const argv = await grokHeadlessArgv({
      home: args.home,
      prompt: args.prompt,
      model: args.model,
      reasoningEffort: args.reasoningEffort,
      resumeSessionId: args.resumeSessionId,
      standingPrompt: args.standingPrompt,
      // Always stream so structured turns still emit thought/text deltas for the activity feed.
      outputFormat: "streaming-json",
      imagePaths: args.imagePaths,
      outputSchema: args.outputSchema,
    });
    return spawnGrokTurn(command, argv, {
      home: args.home,
      env: args.env,
      signal: args.signal,
      shell,
      model: args.model ?? null,
      outputSchema: args.outputSchema,
      onLog: args.onLog,
    });
  }

  startSession(args: Omit<EngineRunArgs, "prompt" | "signal">): EngineSession | null {
    if (envExtraArgs("KING_AI_GROK_ARGS").length) return null;
    return new GrokSession(this.bin, args, args.standingPrompt);
  }
}

export const ADAPTERS: Record<EngineId, EngineAdapter> = {
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
  grok: new GrokAdapter(),
};

export function getAdapter(id: EngineId): EngineAdapter {
  return ADAPTERS[id];
}

export async function detectEngines(): Promise<EngineId[]> {
  const entries = await Promise.all(
    ENGINE_PREFERENCE_ORDER.map(async (id) => ((await binOnPath(ADAPTERS[id].bin)) ? id : null)),
  );
  return entries.filter((id): id is EngineId => id != null);
}

function parseResponseMode(value: unknown): "me" | "each" | "one-of-us" | undefined {
  return value === "me" || value === "each" || value === "one-of-us" ? value : undefined;
}

function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body.trim();
}

function salvageTriage(
  text: string,
): { actionable: boolean; reason?: string; promptNote?: string; responseMode?: "me" | "each" | "one-of-us" } | null {
  const actionable = text.match(/"actionable"\s*:\s*(true|false)/i);
  if (!actionable) return null;
  const reason = text.match(/"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
  const promptNote = text.match(/"prompt_?note"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
  const responseMode = text.match(/"response_?mode"\s*:\s*"(me|each|one-of-us)"/i);
  return {
    actionable: actionable[1].toLowerCase() === "true",
    reason: reason ? reason[1].replace(/\\"/g, '"').slice(0, 500) : "recovered from partial triage output",
    promptNote: promptNote ? promptNote[1].replace(/\\"/g, '"').slice(0, 1200) : undefined,
    responseMode: parseResponseMode(responseMode?.[1]),
  };
}

export function parseTriage(
  text: string,
): { actionable: boolean; reason?: string; promptNote?: string; responseMode?: "me" | "each" | "one-of-us" } | null {
  const cleaned = stripLoneSurrogates(text).trim();
  const raw = extractJsonObject(cleaned);
  try {
    const obj = JSON.parse(raw) as {
      actionable?: unknown;
      reason?: unknown;
      promptNote?: unknown;
      prompt_note?: unknown;
      responseMode?: unknown;
      response_mode?: unknown;
    };
    if (typeof obj.actionable !== "boolean") return salvageTriage(cleaned);
    return {
      actionable: obj.actionable,
      reason: typeof obj.reason === "string" ? obj.reason.slice(0, 500) : undefined,
      promptNote:
        typeof obj.promptNote === "string"
          ? obj.promptNote.slice(0, 1200)
          : typeof obj.prompt_note === "string"
            ? obj.prompt_note.slice(0, 1200)
            : undefined,
      responseMode: parseResponseMode(obj.responseMode ?? obj.response_mode),
    };
  } catch {
    return salvageTriage(cleaned);
  }
}
