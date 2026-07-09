import { spawn } from "node:child_process";
import type { RemoteDevice } from "./remote-devices.js";

export interface RemoteExecOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  executor?: RemoteCommandExecutor;
}

export interface RemoteExecResult {
  ok: boolean;
  device: string;
  host: string;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  evidence: RemoteEvidence[];
  error?: string;
}

export interface RemoteEvidence {
  kind: "command" | "log" | "database" | "redis" | "profile";
  source: string;
  text: string;
  time?: string;
}

export type RemoteCommandExecutor = (
  program: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes: number;
  },
) => Promise<Omit<RemoteExecResult, "device" | "host" | "command" | "evidence">>;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 200 * 1024;

export async function sshExec(
  device: RemoteDevice,
  command: string,
  options: RemoteExecOptions = {},
): Promise<RemoteExecResult> {
  const timeoutMs = normalizePositiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = normalizePositiveInt(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
  const env = { ...process.env, ...(options.env ?? {}) };
  const built = buildSshCommand(device, command, env);
  const started = Date.now();
  const executor = options.executor ?? spawnCapture;
  const result = await executor(built.program, built.args, { env: built.env, timeoutMs, maxOutputBytes });
  return {
    ...result,
    stdout: redactRemoteSecrets(result.stdout, device, env),
    stderr: redactRemoteSecrets(result.stderr, device, env),
    error: result.error ? redactRemoteSecrets(result.error, device, env) : undefined,
    device: device.id,
    host: device.host,
    command,
    durationMs: result.durationMs || Date.now() - started,
    evidence: [
      {
        kind: "command",
        source: `${device.user}@${device.host}`,
        text: command,
      },
    ],
  };
}

export function buildSshCommand(
  device: RemoteDevice,
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): {
  program: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const port = String(device.port ?? 22);
  const target = `${device.user}@${device.host}`;
  const baseArgs = [
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "ConnectTimeout=5",
    "-p",
    port,
  ];
  if (device.identityFile) baseArgs.push("-i", device.identityFile);
  const password = remotePassword(device, env);
  if (password) {
    return {
      program: "sshpass",
      args: ["-e", "ssh", ...baseArgs, target, command],
      env: { ...env, SSHPASS: password },
    };
  }
  return {
    program: "ssh",
    args: [...baseArgs, target, command],
    env,
  };
}

export function remotePassword(device: RemoteDevice, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (device.passwordEnv && env[device.passwordEnv]) return env[device.passwordEnv];
  return device.password;
}

export function redactRemoteSecrets(text: string, device: RemoteDevice, env: NodeJS.ProcessEnv = process.env): string {
  let redacted = text;
  for (const secret of [device.password, device.passwordEnv ? env[device.passwordEnv] : undefined].filter(
    Boolean,
  ) as string[]) {
    redacted = redacted.split(secret).join("<redacted>");
  }
  return redacted;
}

async function spawnCapture(
  program: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes: number;
  },
): Promise<Omit<RemoteExecResult, "device" | "host" | "command" | "evidence">> {
  const started = Date.now();
  return await new Promise((resolve) => {
    const child = spawn(program, args, {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, options.timeoutMs);
    timer.unref?.();

    const append = (chunk: Buffer, target: "stdout" | "stderr") => {
      const text = chunk.toString("utf8");
      if (Buffer.byteLength(stdout + stderr, "utf8") + Buffer.byteLength(text, "utf8") > options.maxOutputBytes) {
        truncated = true;
        const remaining = Math.max(0, options.maxOutputBytes - Buffer.byteLength(stdout + stderr, "utf8"));
        const sliced = Buffer.from(text).subarray(0, remaining).toString("utf8");
        if (target === "stdout") stdout += sliced;
        else stderr += sliced;
        return;
      }
      if (target === "stdout") stdout += text;
      else stderr += text;
    };

    child.stdout?.on("data", (chunk: Buffer) => append(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk, "stderr"));
    child.once("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: 1,
        stdout,
        stderr,
        truncated,
        durationMs: Date.now() - started,
        error: err.message,
      });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const timedOut = signal === "SIGTERM" && Date.now() - started >= options.timeoutMs;
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        stdout,
        stderr,
        truncated,
        durationMs: Date.now() - started,
        ...(timedOut
          ? { error: `remote command timed out after ${options.timeoutMs}ms` }
          : code === 0
            ? {}
            : { error: `remote command exited with code ${code}` }),
      });
    });
  });
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
