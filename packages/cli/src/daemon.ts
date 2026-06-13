import { hostname } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { api, tenantHeader } from "./api.js";
import { loadConfig, saveConfig } from "./config.js";
import { ADAPTERS, detectEngines, getAdapter } from "./engine.js";
import { AGENTS_ROOT, CURRENT_VERSION, HEARTBEAT_PATH, RUNNING_STATE_PATH, SESSIONS_DIR, TRIAGE_DIR } from "./paths.js";
import { checkForUpdate, recordRunningState, rotateLogsIfNeeded, writeRunningState } from "./service.js";
import type { RunningAgentState } from "./service.js";
import { AgentRunner } from "./runner.js";
import type { AgentConfig, ComputerConfig, EngineId } from "./types.js";
import { engineInstallAdvice, engineRemediationAdvice, formatRemediationBlock } from "./remediation.js";
import { detectLocalCapabilities } from "./workspace.js";
import { normalizeAgentLifecycle, shouldHostAgent } from "./lifecycle.js";
import { FileHeartbeat } from "./heartbeat.js";
import { validateAgentConfig } from "./agent-config-validation.js";

const AGENT_POLL_MS = Number(process.env.KING_AI_AGENT_POLL_MS) || 5_000;
const HEARTBEAT_MS = Number(process.env.KING_AI_HEARTBEAT_MS) || 30_000;
const SHUTDOWN_GRACE_MS = Number(process.env.KING_AI_SHUTDOWN_GRACE_MS) || 15_000;
const REHOST_GRACE_MS = Number(process.env.KING_AI_REHOST_GRACE_MS) || 120_000;
const CONFIG_RESYNC_DEBOUNCE_MS = Number(process.env.KING_AI_CONFIG_RESYNC_DEBOUNCE_MS) || 2_000;
const UPDATE_CHECK_MS = Number(process.env.KING_AI_UPDATE_CHECK_MS) || 6 * 60 * 60 * 1000;
const IDLE_UPDATE_CHECK_MS = Number(process.env.KING_AI_IDLE_UPDATE_CHECK_MS) || 30_000;
const LOG_ROTATE_MS = Number(process.env.KING_AI_LOG_ROTATE_MS) || 5 * 60 * 1000;
const SUPERVISED = process.env.KING_AI_SUPERVISED === "1";
const execFileP = promisify(execFile);

export function anyRunnerBusy(runners: Iterable<{ isBusy: boolean }>): boolean {
  for (const runner of runners) {
    if (runner.isBusy) return true;
  }
  return false;
}

export async function waitForRunnerIdle(
  runner: { isBusy: boolean },
  deadlineMs: number,
  pollMs = 100
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (runner.isBusy && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return !runner.isBusy;
}

export function shouldExitForUpdate(args: { updateReady: boolean; shuttingDown: boolean; anyBusy: boolean }): boolean {
  return args.updateReady && !args.shuttingDown && !args.anyBusy;
}

export function installProcessErrorLogging(): void {
  process.on("unhandledRejection", (reason) => {
    console.error("[king-ai] unhandledRejection (kept alive):", reason instanceof Error ? reason.stack || reason.message : reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[king-ai] uncaughtException (kept alive):", err instanceof Error ? err.stack || err.message : err);
  });
}

const LOG_TIMESTAMPS_INSTALLED = Symbol.for("king-ai.logTimestamps");

// Prefix every daemon log line with a high-resolution wall-clock timestamp so wake-to-response
// latency can be measured by diffing line times (e.g. "SSE wake received" -> first "[codex] $").
// Engine output is forwarded through console.* as well, so wrapping here timestamps host and
// engine lines uniformly and matches the codex runtime's own ISO timestamps for easy correlation.
export function installLogTimestamps(now: () => Date = () => new Date()): void {
  const globalState = globalThis as unknown as Record<symbol, boolean>;
  if (globalState[LOG_TIMESTAMPS_INSTALLED]) return;
  globalState[LOG_TIMESTAMPS_INSTALLED] = true;
  const methods = ["log", "info", "warn", "error"] as const;
  for (const method of methods) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]): void => {
      original(`[${now().toISOString()}]`, ...args);
    };
  }
}

export function resolveHostName(base: string | undefined | null, platform: NodeJS.Platform, platformNames: string[] = []): string {
  if (base && base.toLowerCase() !== "localhost") return base;
  if (platform === "darwin") {
    const found = platformNames.map((name) => name.trim()).find(Boolean);
    if (found) return found;
  }
  return base || "My computer";
}

export async function detectHostName(): Promise<string> {
  const base = hostname();
  const platformNames: string[] = [];
  if (process.platform === "darwin") {
    for (const key of ["ComputerName", "LocalHostName"]) {
      try {
        const { stdout } = await execFileP("scutil", ["--get", key]);
        platformNames.push(stdout);
      } catch {
        // Keep fallback behavior portable.
      }
    }
  }
  return resolveHostName(base, process.platform, platformNames);
}

export function missingEngineMessage(): string {
  return [
    "no supported local agent engine found on PATH",
    "",
    "Install and sign in to at least one of:",
    "  - Claude Code: install the `claude` CLI, then run `claude` once to sign in",
    "  - Codex: install the `codex` CLI, then run `codex` once to sign in",
    "  - Grok: install the `grok` CLI, then run `grok login` (or set XAI_API_KEY)",
    "",
    "After that, rerun:",
    "  king-ai agent computer --pair <code>"
  ].join("\n");
}

export interface PairLocator {
  code: string;
  serverUrl?: string;
  tenantId?: string;
}

export function parsePairLocator(value: string): PairLocator {
  const trimmed = value.trim();
  if (!trimmed.startsWith("king-ai://pair?")) return { code: trimmed };
  const url = new URL(trimmed);
  const code = url.searchParams.get("code")?.trim();
  const serverUrl = url.searchParams.get("server")?.trim().replace(/\/+$/, "");
  const tenantId = url.searchParams.get("tenant")?.trim() || undefined;
  if (!code) throw new Error("pair locator is missing code");
  if (serverUrl) new URL(serverUrl);
  return { code, serverUrl: serverUrl || undefined, tenantId };
}

export interface DoctorProbe {
  ok: boolean;
  detail?: string;
}

export interface DoctorResult {
  id: EngineId;
  installed: boolean;
  path?: string;
  big?: DoctorProbe;
  small?: DoctorProbe;
}

export function doctorExitCode(results: DoctorResult[]): number {
  return results.some((result) => result.big?.ok && result.small?.ok) ? 0 : 1;
}

export function formatDoctorReport(results: DoctorResult[], version = CURRENT_VERSION): string {
  const lines = [
    `king-ai ${version} engine doctor`,
    "probing local engines (big brain = main reasoning, small brain = triage cerebellum)...",
    ""
  ];
  let anyUsable = false;
  for (const result of results) {
    if (!result.installed) {
      lines.push(`x ${result.id} - not found on PATH`);
      for (const line of formatRemediationBlock(engineInstallAdvice(result.id)).split("\n")) lines.push(`    ${line}`);
      lines.push("");
      continue;
    }
    lines.push(`o ${result.id} - ${result.path ?? "on PATH"}`);
    for (const [label, probe] of [
      ["big brain  ", result.big],
      ["small brain", result.small]
    ] as const) {
      if (!probe) continue;
      if (probe.ok) {
        lines.push(`    ok ${label}`);
      } else {
        const detail = probe.detail ?? "unknown failure";
        lines.push(`    x  ${label} FAILED: ${detail}`);
        for (const line of formatRemediationBlock(engineRemediationAdvice(result.id, detail)).split("\n")) lines.push(`       ${line}`);
      }
    }
    if (result.big?.ok && result.small?.ok) anyUsable = true;
    lines.push("");
  }
  if (!anyUsable) {
    lines.push("x no engine has BOTH brains healthy - this machine cannot currently run a BYOA agent.");
    lines.push("  Fix one engine above, then re-run: king-ai agent computer --doctor");
  }
  return lines.join("\n").trimEnd();
}

export async function collectDoctorResults(): Promise<DoctorResult[]> {
  const engines = await detectEngines();
  const results: DoctorResult[] = [];
  for (const id of Object.keys(ADAPTERS) as EngineId[]) {
    if (!engines.includes(id)) {
      results.push({ id, installed: false });
      continue;
    }
    const adapter = getAdapter(id);
    const cwd = await mkdtemp(join(tmpdir(), "king-doctor-"));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const big = await adapter.probe({ cwd, env: process.env, tier: "big", signal: controller.signal });
      const small = await adapter.probe({ cwd, env: process.env, tier: "small", signal: controller.signal });
      results.push({
        id,
        installed: true,
        path: adapter.bin,
        big: { ok: !big.error, detail: big.error },
        small: { ok: !small.error, detail: small.error }
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  return results;
}

export async function doPair(code: string, serverUrl: string, preferredEngine?: EngineId, tenantId?: string): Promise<void> {
  const locator = parsePairLocator(code);
  const resolvedServerUrl = locator.serverUrl ?? serverUrl;
  const resolvedTenantId = locator.tenantId ?? tenantId;
  const detected = await detectEngines();
  if (detected.length === 0) throw new Error(missingEngineMessage());
  const engines = preferredEngine ? [preferredEngine, ...detected.filter((id) => id !== preferredEngine)] : detected;
  if (preferredEngine && !detected.includes(preferredEngine)) {
    throw new Error(`--engine ${preferredEngine} chosen, but ${preferredEngine} is not installed on this machine. Installed: ${detected.join(", ") || "none"}.`);
  }
  const paired = await api<{ computerId: string; deviceToken: string; tenantId?: string }>(resolvedServerUrl, "/api/computers/pair", {
    method: "POST",
    headers: tenantHeader(resolvedTenantId),
    body: JSON.stringify({ code: locator.code, hostName: await detectHostName(), engines, version: CURRENT_VERSION, capabilities: detectLocalCapabilities() })
  });
  const savedTenantId = paired.tenantId ?? resolvedTenantId;
  await saveConfig({ serverUrl: resolvedServerUrl, computerId: paired.computerId, deviceToken: paired.deviceToken, ...(savedTenantId ? { tenantId: savedTenantId } : {}) });
  await clearLocalRuntimeState();
  console.log(`paired as ${paired.computerId}${savedTenantId ? ` tenant=${savedTenantId}` : ""}; default engine: ${engines[0] ?? "none"}; available engines: ${engines.join(", ") || "none"}`);
}

export async function clearLocalRuntimeState(paths = {
  agentsRoot: AGENTS_ROOT,
  sessionsDir: SESSIONS_DIR,
  triageDir: TRIAGE_DIR,
  runningStatePath: RUNNING_STATE_PATH,
  heartbeatPath: HEARTBEAT_PATH
}): Promise<void> {
  await Promise.all([
    rm(paths.agentsRoot, { recursive: true, force: true }),
    rm(paths.sessionsDir, { recursive: true, force: true }),
    rm(paths.triageDir, { recursive: true, force: true }),
    rm(paths.runningStatePath, { force: true }),
    rm(paths.heartbeatPath, { force: true })
  ]);
}

export async function runDoctor(): Promise<void> {
  const results = await collectDoctorResults();
  console.log(formatDoctorReport(results));
  if (doctorExitCode(results) !== 0) process.exitCode = 1;
}

export async function doRun(serverOverride?: string, tenantOverride?: string): Promise<void> {
  installProcessErrorLogging();
  installLogTimestamps();
  const cfg = await loadConfig();
  if (!cfg) throw new Error("not paired. Run: king-ai agent computer --pair <code> --server <url>");
  const runtimeCfg: ComputerConfig = { ...cfg, serverUrl: serverOverride ?? cfg.serverUrl, tenantId: tenantOverride ?? cfg.tenantId };
  const available = await detectEngines();
  if (available.length === 0) throw new Error(missingEngineMessage());
  console.log(`king-ai ${CURRENT_VERSION} starting ${runtimeCfg.computerId} @ ${runtimeCfg.serverUrl}`);
  const fileHeartbeat = new FileHeartbeat(HEARTBEAT_PATH, {
    pid: process.pid,
    runId: `${runtimeCfg.computerId}-${Date.now()}`,
    version: CURRENT_VERSION,
    computerId: runtimeCfg.computerId,
    serverUrl: runtimeCfg.serverUrl
  });
  fileHeartbeat.write();
  const capabilities = detectLocalCapabilities();
  await writeRunningState({
    serverUrl: runtimeCfg.serverUrl,
    computerId: runtimeCfg.computerId,
    capabilities,
    agents: [],
    event: { at: new Date().toISOString(), kind: "daemon.started", detail: `${runtimeCfg.computerId} @ ${runtimeCfg.serverUrl}` }
  });
  await rotateLogsIfNeeded();

  const runners = new Map<string, AgentRunner>();
  const publishRunningAgents = (extra: RunningAgentState[] = []) => {
    recordRunningState({
      capabilities: detectLocalCapabilities(),
      agents: [
        ...[...runners.values()].map((runner) => runner.runningState()),
        ...extra
      ]
    });
  };
  const runSync = async () => {
    let agents: AgentConfig[];
    try {
      agents = await api<AgentConfig[]>(runtimeCfg.serverUrl, "/api/computers/me/agents", {
        headers: { Authorization: `Bearer ${runtimeCfg.deviceToken}`, ...tenantHeader(runtimeCfg.tenantId) }
      });
    } catch (err) {
      console.warn(`agent sync failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const disabledAgents: AgentConfig[] = [];
    for (const agent of agents) {
      const lifecycle = normalizeAgentLifecycle(agent.lifecycle);
      if (!shouldHostAgent(lifecycle)) {
        const existing = runners.get(agent.id);
        if (existing) {
          existing.stop();
          runners.delete(agent.id);
        }
        disabledAgents.push({ ...agent, lifecycle });
        recordRunningState({
          event: { at: new Date().toISOString(), kind: "agent.disabled", detail: agent.id }
        });
        continue;
      }
      const engine = agent.engine && available.includes(agent.engine) ? agent.engine : available[0];
      const existing = runners.get(agent.id);
      if (existing?.configMatches(agent, engine)) continue;
      if (existing) {
        if (existing.isBusy) {
          console.log(`waiting for ${agent.id} to finish in-flight turn before re-hosting on ${engine}`);
        }
        const idle = await waitForRunnerIdle(existing, REHOST_GRACE_MS);
        if (!idle) {
          console.warn(`${agent.id} still busy after ${Math.round(REHOST_GRACE_MS / 1000)}s; re-hosting on ${engine} anyway`);
        }
        existing.stop();
      }
      const runner = new AgentRunner(runtimeCfg, { ...agent, lifecycle }, engine, available, () => publishRunningAgents(), requestResync);
      runners.set(agent.id, runner);
      console.log(`hosting ${agent.name} (${agent.id}) on ${engine} lifecycle=${lifecycle}`);
      recordRunningState({
        event: { at: new Date().toISOString(), kind: "agent.hosting", detail: `${agent.id} on ${engine} lifecycle=${lifecycle}` }
      });
      await runner.start();
    }
    const live = new Set(agents.filter((a) => shouldHostAgent(normalizeAgentLifecycle(a.lifecycle))).map((a) => a.id));
    for (const [id, runner] of runners) {
      if (!live.has(id)) {
        runner.stop();
        runners.delete(id);
        recordRunningState({
          event: { at: new Date().toISOString(), kind: "agent.removed", detail: id }
        });
      }
    }
    publishRunningAgents(
      disabledAgents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          engine: agent.engine ?? "disabled",
          lifecycle: "disabled" as const,
          status: "disabled" as const,
          configWarnings: validateAgentConfig(agent, agent.engine ?? "disabled", available),
          updatedAt: new Date().toISOString()
        }))
    );
    recordRunningState({
      lastSyncAt: new Date().toISOString()
    });
  };

  // Serialize syncs so a poll and a config-triggered re-sync can't race and double-host an agent.
  let syncing = false;
  let syncQueued = false;
  const sync = async (): Promise<void> => {
    if (syncing) {
      syncQueued = true;
      return;
    }
    syncing = true;
    try {
      await runSync();
    } finally {
      syncing = false;
      if (syncQueued) {
        syncQueued = false;
        void sync();
      }
    }
  };
  // Coalesce the burst of config events (one per connected runner) into a single re-sync.
  let resyncTimer: NodeJS.Timeout | null = null;
  const requestResync = () => {
    if (resyncTimer) return;
    resyncTimer = setTimeout(() => {
      resyncTimer = null;
      void sync();
    }, CONFIG_RESYNC_DEBOUNCE_MS);
  };

  const heartbeat = () => {
    const at = new Date().toISOString();
    const capabilities = detectLocalCapabilities();
    return fetch(`${runtimeCfg.serverUrl}/api/computers/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${runtimeCfg.deviceToken}`, ...tenantHeader(runtimeCfg.tenantId) },
      body: JSON.stringify({ version: CURRENT_VERSION, capabilities })
    }).then(() => {
      fileHeartbeat.tick();
      recordRunningState({ lastHeartbeatAt: at, capabilities });
    }).catch(() => {
      fileHeartbeat.tick();
      recordRunningState({ event: { at, kind: "heartbeat.failed", detail: runtimeCfg.serverUrl } });
    });
  };

  await heartbeat();
  await sync();
  const syncTimer = setInterval(() => void sync(), AGENT_POLL_MS);
  const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_MS);
  const logRotateTimer = setInterval(() => void rotateLogsIfNeeded(), LOG_ROTATE_MS);
  logRotateTimer.unref?.();
  let updateTimer: NodeJS.Timeout | null = null;
  let idleUpdateTimer: NodeJS.Timeout | null = null;
  let updateReady = false;
  let shuttingDown = false;
  const shutdown = async (why: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(syncTimer);
    clearInterval(heartbeatTimer);
    clearInterval(logRotateTimer);
    if (updateTimer) clearInterval(updateTimer);
    if (idleUpdateTimer) clearInterval(idleUpdateTimer);
    for (const runner of runners.values()) runner.beginStop();
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    if (anyRunnerBusy(runners.values())) {
      console.log(`${why}: waiting up to ${Math.round(SHUTDOWN_GRACE_MS / 1000)}s for in-flight turn(s) to finish`);
    }
    while (anyRunnerBusy(runners.values()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    for (const runner of runners.values()) runner.stop();
    console.log(`shutting down (${why})`);
    process.exit(0);
  };
  const exitForUpdateWhenIdle = () => {
    if (!shouldExitForUpdate({ updateReady, shuttingDown, anyBusy: anyRunnerBusy(runners.values()) })) return;
    void shutdown("auto-update");
  };
  const runUpdateCheck = () => {
    void checkForUpdate().then((latest) => {
      if (!latest) return;
      if (SUPERVISED) {
        if (!updateReady) {
          updateReady = true;
          console.log(`king-ai ${latest} available; will restart when idle`);
        }
        exitForUpdateWhenIdle();
      } else {
        console.log(`king-ai ${latest} available. Restart to update, or install the background service for automatic restarts.`);
      }
    });
  };
  updateTimer = setInterval(runUpdateCheck, UPDATE_CHECK_MS);
  updateTimer.unref?.();
  idleUpdateTimer = setInterval(exitForUpdateWhenIdle, IDLE_UPDATE_CHECK_MS);
  idleUpdateTimer.unref?.();
  setTimeout(runUpdateCheck, 60_000).unref?.();
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
