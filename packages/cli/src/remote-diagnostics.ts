import type { RemoteDevice, RemoteDevicesConfig } from "./remote-devices.js";
import { findRemoteDevice, listRemoteDeviceSummaries } from "./remote-devices.js";
import { sshExec } from "./remote-ssh.js";
import type { RemoteCommandExecutor, RemoteExecOptions, RemoteExecResult } from "./remote-ssh.js";

export interface RemoteCommandInput {
  device?: unknown;
  timeoutMs?: unknown;
  maxOutputBytes?: unknown;
}

export interface RemoteRunInput extends RemoteCommandInput {
  cmd?: unknown;
}

export interface RemoteLogsInput extends RemoteCommandInput {
  app?: unknown;
  path?: unknown;
  tail?: unknown;
}

export interface RemoteFindLogsInput extends RemoteLogsInput {
  pattern?: unknown;
  since?: unknown;
}

export interface RemoteServiceInput extends RemoteCommandInput {
  db?: unknown;
  name?: unknown;
  sql?: unknown;
  cmd?: unknown;
}

export interface RemoteDeviceCommandDeps {
  config: RemoteDevicesConfig;
  env?: NodeJS.ProcessEnv;
  executor?: RemoteCommandExecutor;
}

export function formatRemoteResult(result: RemoteExecResult): string {
  const status = result.ok ? "ok" : "failed";
  const parts = [
    `remote ${status}: ${result.device} ${result.command}`,
    result.stdout.trim(),
    result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
    result.truncated ? "(output truncated)" : "",
    result.error ? `error: ${result.error}` : "",
  ].filter(Boolean);
  return parts.join("\n");
}

export function formatRemoteDevices(config: RemoteDevicesConfig): string {
  const rows = listRemoteDeviceSummaries(config);
  if (rows.length === 0) return "no remote test devices configured";
  return rows
    .map(
      (device) =>
        `${device.id}\t${device.user}@${device.host}:${device.port ?? 22}\t${device.name ?? ""}\t${device.auth}`,
    )
    .join("\n");
}

export async function remoteProbe(input: unknown, deps: RemoteDeviceCommandDeps): Promise<RemoteExecResult> {
  const parsed = normalizeRemoteCommandInput(input);
  const device = findRemoteDevice(deps.config, parsed.device);
  return sshExec(device, "hostname && whoami && pwd && uptime", execOptions(parsed, deps));
}

export async function remoteProfile(input: unknown, deps: RemoteDeviceCommandDeps): Promise<RemoteExecResult> {
  const parsed = normalizeRemoteCommandInput(input);
  const device = findRemoteDevice(deps.config, parsed.device);
  const markers = Object.values(device.apps ?? {}).flatMap((app) => app.installMarkers ?? []);
  const markerScript = markers.length
    ? markers
        .map((marker) => `if [ -f ${sh(marker)} ]; then echo "marker ${marker}=$(cat ${sh(marker)} 2>/dev/null)"; fi`)
        .join("\n")
    : "true";
  const logRoots = Object.values(device.apps ?? {}).flatMap((app) => app.logRoots ?? []);
  const logScript = logRoots.length
    ? `for d in ${logRoots.map(sh).join(" ")}; do if [ -d "$d" ]; then echo "logroot $d"; find "$d" -type f -maxdepth 2 2>/dev/null | xargs ls -t 2>/dev/null | head -20; fi; done`
    : "true";
  const command = [
    "echo '[system]'",
    "hostname",
    "whoami",
    "uptime",
    "echo '[install-markers]'",
    markerScript,
    "echo '[services]'",
    "command -v systemctl >/dev/null 2>&1 && systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | head -50 || ps -ef | head -30",
    "echo '[logs]'",
    logScript,
  ].join("\n");
  const result = await sshExec(device, command, execOptions(parsed, deps));
  return {
    ...result,
    evidence: [{ kind: "profile", source: `${device.user}@${device.host}`, text: "remote environment profile" }],
  };
}

export async function remoteRun(input: unknown, deps: RemoteDeviceCommandDeps): Promise<RemoteExecResult> {
  const parsed = normalizeRemoteRunInput(input);
  const device = findRemoteDevice(deps.config, parsed.device);
  return sshExec(device, parsed.cmd, execOptions(parsed, deps));
}

export async function remoteLogs(input: unknown, deps: RemoteDeviceCommandDeps): Promise<RemoteExecResult> {
  const parsed = normalizeRemoteLogsInput(input);
  const device = findRemoteDevice(deps.config, parsed.device);
  const app = appConfig(device, parsed.app);
  const target = parsed.path || newestLogCommand(app.logRoots ?? []);
  const command = parsed.path
    ? `tail -n ${parsed.tail} ${sh(parsed.path)}`
    : `f=$(${target}); if [ -n "$f" ]; then echo "==> $f <=="; tail -n ${parsed.tail} "$f"; else echo "no log file found"; exit 2; fi`;
  const result = await sshExec(device, command, execOptions(parsed, deps));
  return {
    ...result,
    evidence: [
      {
        kind: "log",
        source: parsed.path || parsed.app || device.defaultApp || "logs",
        text: result.stdout.slice(0, 2000),
      },
    ],
  };
}

export async function remoteFindLogs(input: unknown, deps: RemoteDeviceCommandDeps): Promise<RemoteExecResult> {
  const parsed = normalizeRemoteFindLogsInput(input);
  const device = findRemoteDevice(deps.config, parsed.device);
  const app = appConfig(device, parsed.app);
  const roots = app.logRoots ?? [];
  if (roots.length === 0 && !parsed.path) throw new Error("remote-find-logs requires path or app logRoots");
  const sources = parsed.path ? [parsed.path] : roots;
  const since = parsed.since ? ` since=${parsed.since}` : "";
  const command = [
    `echo "pattern=${parsed.pattern}${since}"`,
    `for p in ${sources.map(sh).join(" ")}; do`,
    '  if [ -f "$p" ]; then grep -E -n --color=never ' + sh(parsed.pattern) + ' "$p" | tail -n ' + parsed.tail + "; fi",
    '  if [ -d "$p" ]; then find "$p" -type f -maxdepth 2 2>/dev/null | xargs grep -E -n --color=never ' +
      sh(parsed.pattern) +
      " 2>/dev/null | tail -n " +
      parsed.tail +
      "; fi",
    "done",
  ].join("\n");
  const result = await sshExec(device, command, execOptions(parsed, deps));
  return { ...result, evidence: [{ kind: "log", source: sources.join(","), text: result.stdout.slice(0, 2000) }] };
}

export async function remotePg(input: unknown, deps: RemoteDeviceCommandDeps): Promise<RemoteExecResult> {
  const parsed = normalizeRemoteServiceInput(input, "sql");
  const device = findRemoteDevice(deps.config, parsed.device);
  const name = parsed.db || "default";
  const service = device.databases?.[name];
  if (!service) throw new Error(`remote database not configured: ${name}`);
  const command = `${service.command} -c ${sh(parsed.sql)}`;
  const result = await sshExec(device, command, execOptions(parsed, deps));
  return { ...result, evidence: [{ kind: "database", source: name, text: parsed.sql }] };
}

export async function remoteRedis(input: unknown, deps: RemoteDeviceCommandDeps): Promise<RemoteExecResult> {
  const parsed = normalizeRemoteServiceInput(input, "cmd");
  const device = findRemoteDevice(deps.config, parsed.device);
  const name = parsed.name || "default";
  const service = device.redis?.[name];
  if (!service) throw new Error(`remote redis not configured: ${name}`);
  const command = `${service.command} ${parsed.cmd}`;
  const result = await sshExec(device, command, execOptions(parsed, deps));
  return { ...result, evidence: [{ kind: "redis", source: name, text: parsed.cmd }] };
}

function execOptions(
  input: { timeoutMs?: number; maxOutputBytes?: number },
  deps: RemoteDeviceCommandDeps,
): RemoteExecOptions {
  return {
    timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxOutputBytes,
    env: deps.env,
    executor: deps.executor,
  };
}

function normalizeRemoteCommandInput(input: unknown): { device?: string; timeoutMs?: number; maxOutputBytes?: number } {
  const record = objectInput(input);
  return {
    device: optionalString(record.device),
    timeoutMs: optionalPositiveInt(record.timeoutMs, "timeoutMs"),
    maxOutputBytes: optionalPositiveInt(record.maxOutputBytes, "maxOutputBytes"),
  };
}

function normalizeRemoteRunInput(input: unknown): {
  device?: string;
  cmd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
} {
  const base = normalizeRemoteCommandInput(input);
  const record = objectInput(input);
  return { ...base, cmd: requiredString(record.cmd, "cmd") };
}

function normalizeRemoteLogsInput(input: unknown): {
  device?: string;
  app?: string;
  path?: string;
  tail: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
} {
  const base = normalizeRemoteCommandInput(input);
  const record = objectInput(input);
  return {
    ...base,
    app: optionalString(record.app),
    path: optionalString(record.path),
    tail: optionalPositiveInt(record.tail, "tail") ?? 200,
  };
}

function normalizeRemoteFindLogsInput(input: unknown): {
  device?: string;
  app?: string;
  path?: string;
  pattern: string;
  since?: string;
  tail: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
} {
  const base = normalizeRemoteLogsInput(input);
  const record = objectInput(input);
  return {
    ...base,
    pattern: requiredString(record.pattern, "pattern"),
    since: optionalString(record.since),
  };
}

function normalizeRemoteServiceInput(
  input: unknown,
  field: "sql" | "cmd",
): {
  device?: string;
  db?: string;
  name?: string;
  sql: string;
  cmd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
} {
  const base = normalizeRemoteCommandInput(input);
  const record = objectInput(input);
  const value = requiredString(record[field], field);
  return {
    ...base,
    db: optionalString(record.db),
    name: optionalString(record.name),
    sql: field === "sql" ? value : "",
    cmd: field === "cmd" ? value : "",
  };
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input) return {};
  if (typeof input !== "object") throw new Error("remote command input must be an object");
  return input as Record<string, unknown>;
}

function appConfig(device: RemoteDevice, appName?: string) {
  const name = appName || device.defaultApp;
  if (!name) return {};
  const app = device.apps?.[name];
  if (!app) throw new Error(`remote app not configured: ${name}`);
  return app;
}

function newestLogCommand(roots: string[]): string {
  if (roots.length === 0) return "find /var/log -type f 2>/dev/null | xargs ls -t 2>/dev/null | head -1";
  return `for d in ${roots.map(sh).join(" ")}; do [ -d "$d" ] && find "$d" -type f -maxdepth 2 2>/dev/null; done | xargs ls -t 2>/dev/null | head -1`;
}

function requiredString(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`${label} is required`);
  return raw.trim();
}

function optionalString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function optionalPositiveInt(raw: unknown, label: string): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return Math.floor(value);
}

function sh(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
