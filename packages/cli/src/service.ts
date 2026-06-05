import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { CONFIG_DIR, CURRENT_VERSION, RUNNING_STATE_PATH, SERVICE_LABEL } from "./paths.js";
import type { CommandName } from "./paths.js";
import { loadConfig } from "./config.js";
import type { LocalCapabilities } from "./workspace.js";
import type { WorktreePlan } from "./worktree.js";
import { cleanupWorktreePlans, formatWorktreeCleanupResults, formatWorktreePreparationResults, prepareWorktreePlans } from "./worktree.js";
import type { AgentRunStats } from "./usage.js";
import type { TokenBudgetCheck } from "./usage.js";
import { formatAgentRunStats, formatTokenBudgetCheck } from "./usage.js";
import type { RemediationAdvice } from "./remediation.js";
import type { AgentConfigWarning } from "./agent-config-validation.js";

const execFileP = promisify(execFile);
const LOG_MAX_BYTES = 20 * 1024 * 1024;
export type DarwinServiceStatus = {
  pid: number | null;
  lastExitStatus: number | null;
};

export type RunningEvent = {
  at: string;
  kind: string;
  detail?: string;
};

export type RunningEventCategory = "agent" | "turn" | "budget" | "daemon" | "other";

export type RunningAgentState = {
  id: string;
  name: string;
  engine: string;
  lifecycle?: string;
  status?: "idle" | "running" | "disabled";
  model?: string;
  sharedSkillSnapshot?: {
    id: string;
    root: string;
    manifestPath: string;
    skills: string[];
  } | null;
  hostHomeEntries?: Array<{
    name: string;
    source: string;
    target: string;
    linked: boolean;
    reason?: string;
  }>;
  workspaceRoot?: string;
  worktreePlans?: WorktreePlan[];
  worktreeMaterializationEnabled?: boolean;
  runStats?: AgentRunStats;
  tokenBudget?: TokenBudgetCheck;
  remediation?: RemediationAdvice | null;
  configWarnings?: AgentConfigWarning[];
  updatedAt: string;
};

export type RunningState = {
  version: string;
  pid: number;
  startedAt: string;
  serverUrl?: string;
  computerId?: string;
  capabilities?: LocalCapabilities;
  lastHeartbeatAt?: string;
  lastSyncAt?: string;
  agents?: RunningAgentState[];
  events?: RunningEvent[];
};

export function daemonLogPath(): string {
  return join(CONFIG_DIR, "daemon.log");
}

export function serviceNames(commandName: CommandName = "king-ai"): { packageName: string; serviceUnit: string; displayName: string; serviceLabel: string } {
  return {
    packageName: "@suwujs/king-ai",
    serviceUnit: "king-ai",
    displayName: "King AI",
    serviceLabel: "io.king-ai.daemon"
  };
}

export function updateRegistryUrl(commandName: CommandName = "king-ai"): string {
  return `https://registry.npmjs.org/${encodeURIComponent(serviceNames(commandName).packageName)}/latest`;
}

export function versionGt(a: string, b: string): boolean {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

function resolveNpx(): string {
  const sibling = join(dirname(process.execPath), "npx");
  return existsSync(sibling) ? sibling : "npx";
}

function darwinPlistPath(commandName: CommandName = "king-ai"): string {
  return join(homedir(), "Library", "LaunchAgents", `${serviceNames(commandName).serviceLabel}.plist`);
}

function linuxUnitPath(commandName: CommandName = "king-ai"): string {
  return join(homedir(), ".config", "systemd", "user", `${serviceNames(commandName).serviceUnit}.service`);
}

function windowsServiceDir(commandName: CommandName = "king-ai"): string {
  return join(CONFIG_DIR, "service", commandName);
}

export function windowsTaskName(commandName: CommandName = "king-ai"): string {
  return `KingAI.BYOA.${serviceNames(commandName).serviceUnit}`;
}

export function windowsWrapperPath(commandName: CommandName = "king-ai"): string {
  return join(windowsServiceDir(commandName), "king-ai-agent-computer.cmd");
}

export function buildWindowsServiceWrapper(args: string[], logPath = daemonLogPath()): string {
  const quotedArgs = args.map(windowsCmdQuote).join(" ");
  return [
    "@echo off",
    "setlocal",
    "set KING_AI_SUPERVISED=1",
    `echo [%date% %time%] starting King AI daemon>>${windowsCmdQuote(logPath)}`,
    `${quotedArgs} >>${windowsCmdQuote(logPath)} 2>&1`
  ].join("\r\n") + "\r\n";
}

export function parseWindowsTaskStatus(stdout: string): { status?: string; lastResult?: string; taskName?: string } {
  return {
    taskName: stdout.match(/^TaskName:\s*(.+)$/im)?.[1]?.trim(),
    status: stdout.match(/^Status:\s*(.+)$/im)?.[1]?.trim(),
    lastResult: stdout.match(/^Last Result:\s*(.+)$/im)?.[1]?.trim()
  };
}

export function shouldKillDaemonCommand(command: string): boolean {
  return (
    /agent computer/.test(command) &&
    !/--(stop|status|restart|logs|version|install-service|uninstall-service|pair)\b|\bnpx\b/.test(command)
  );
}

export function parseDarwinLaunchctlStatus(stdout: string): DarwinServiceStatus {
  const pidText = stdout.match(/"PID"\s*=\s*(\d+)/)?.[1];
  const lastExitText = stdout.match(/"LastExitStatus"\s*=\s*(-?\d+)/)?.[1];
  return {
    pid: pidText ? Number(pidText) : null,
    lastExitStatus: lastExitText ? Number(lastExitText) : null
  };
}

export function parseLinuxMainPid(stdout: string): number | null {
  const pid = Number(stdout.trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export async function reloadService(commandName: CommandName = "king-ai"): Promise<void> {
  const names = serviceNames(commandName);
  if (process.platform === "darwin") {
    const plistPath = darwinPlistPath(commandName);
    await execFileP("launchctl", ["unload", plistPath]).catch(() => undefined);
    await execFileP("launchctl", ["load", plistPath]);
    return;
  }
  if (process.platform === "linux") {
    await execFileP("systemctl", ["--user", "restart", names.serviceUnit]);
  }
}

export async function installService(serverUrl?: string, commandName: CommandName = "king-ai"): Promise<void> {
  const names = serviceNames(commandName);
  const cfg = await loadConfig();
  if (!cfg) throw new Error(`pair this computer first: ${names.displayName} agent computer --pair <code>`);
  const resolvedServerUrl = serverUrl ?? cfg.serverUrl;
  const tenantArgs = cfg.tenantId ? ["--tenant", cfg.tenantId] : [];
  const npx = resolveNpx();
  const logPath = daemonLogPath();
  await mkdir(CONFIG_DIR, { recursive: true });
  if (process.platform === "darwin") {
    await mkdir(dirname(darwinPlistPath(commandName)), { recursive: true });
    const plistPath = darwinPlistPath(commandName);
    const args = [npx, "-y", `${names.packageName}@latest`, "agent", "computer", "--server", resolvedServerUrl, ...tenantArgs];
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${names.serviceLabel}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${a}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${process.env.PATH ?? ""}</string>
    <key>KING_AI_SUPERVISED</key><string>1</string>
  </dict>
</dict></plist>`;
    await writeFile(plistPath, plist, "utf8");
    await execFileP("launchctl", ["unload", plistPath]).catch(() => undefined);
    await execFileP("launchctl", ["load", plistPath]);
    console.log(`installed LaunchAgent ${names.serviceLabel}. Logs: ${logPath}`);
    return;
  }
  if (process.platform === "linux") {
    await mkdir(dirname(linuxUnitPath(commandName)), { recursive: true });
    const unitPath = linuxUnitPath(commandName);
    const unit = `[Unit]
Description=King AI BYOA daemon
After=network-online.target

[Service]
ExecStart=${npx} -y ${names.packageName}@latest agent computer --server ${resolvedServerUrl}${tenantArgs.length ? ` --tenant ${tenantArgs[1]}` : ""}
Restart=always
RestartSec=5
Environment=PATH=${process.env.PATH ?? ""}
Environment=KING_AI_SUPERVISED=1

[Install]
WantedBy=default.target
`;
    await writeFile(unitPath, unit, "utf8");
    await execFileP("systemctl", ["--user", "daemon-reload"]);
    await execFileP("systemctl", ["--user", "enable", "--now", names.serviceUnit]);
    console.log(`installed systemd --user service ${names.serviceUnit}`);
    return;
  }
  if (process.platform === "win32") {
    await mkdir(windowsServiceDir(commandName), { recursive: true });
    const resolvedArgs = [resolveNpx(), "-y", `${names.packageName}@latest`, "agent", "computer", "--server", resolvedServerUrl, ...tenantArgs];
    const wrapperPath = windowsWrapperPath(commandName);
    await writeFile(wrapperPath, buildWindowsServiceWrapper(resolvedArgs), "utf8");
    await execFileP("schtasks", ["/Delete", "/TN", windowsTaskName(commandName), "/F"]).catch(() => undefined);
    await execFileP("schtasks", [
      "/Create",
      "/TN", windowsTaskName(commandName),
      "/SC", "ONLOGON",
      "/TR", wrapperPath,
      "/RL", "LIMITED",
      "/F"
    ]);
    await execFileP("schtasks", ["/Run", "/TN", windowsTaskName(commandName)]).catch(() => undefined);
    console.log(`installed Windows scheduled task ${windowsTaskName(commandName)}. Logs: ${daemonLogPath()}`);
    return;
  }
  throw new Error(`service installation is not supported on ${process.platform}`);
}

export async function uninstallService(commandName: CommandName = "king-ai"): Promise<void> {
  const names = serviceNames(commandName);
  if (process.platform === "darwin") {
    const plistPath = darwinPlistPath(commandName);
    await execFileP("launchctl", ["unload", plistPath]).catch(() => undefined);
    await rm(plistPath, { force: true });
    console.log(`removed LaunchAgent ${names.serviceLabel}`);
    return;
  }
  if (process.platform === "linux") {
    await execFileP("systemctl", ["--user", "disable", "--now", names.serviceUnit]).catch(() => undefined);
    await rm(linuxUnitPath(commandName), { force: true });
    await execFileP("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
    console.log(`removed systemd --user service ${names.serviceUnit}`);
    return;
  }
  if (process.platform === "win32") {
    await execFileP("schtasks", ["/End", "/TN", windowsTaskName(commandName)]).catch(() => undefined);
    await execFileP("schtasks", ["/Delete", "/TN", windowsTaskName(commandName), "/F"]).catch(() => undefined);
    await rm(windowsServiceDir(commandName), { recursive: true, force: true });
    console.log(`removed Windows scheduled task ${windowsTaskName(commandName)}`);
    return;
  }
  throw new Error(`service removal is not supported on ${process.platform}`);
}

export function isServiceInstalled(commandName: CommandName = "king-ai"): boolean {
  if (process.platform === "darwin") return existsSync(darwinPlistPath(commandName));
  if (process.platform === "linux") return existsSync(linuxUnitPath(commandName));
  if (process.platform === "win32") {
    try {
      execFileSync("schtasks", ["/Query", "/TN", windowsTaskName(commandName)], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function restartService(commandName: CommandName = "king-ai"): Promise<void> {
  const names = serviceNames(commandName);
  if (!isServiceInstalled(commandName)) {
    console.log(`service not installed; run: ${names.displayName} agent computer --install-service`);
    return;
  }
  if (process.platform === "darwin") {
    const uid = process.getuid?.() ?? 0;
    await execFileP("launchctl", ["kickstart", "-k", `gui/${uid}/${names.serviceLabel}`]).catch(() => reloadService(commandName));
  } else if (process.platform === "linux") {
    await execFileP("systemctl", ["--user", "restart", names.serviceUnit]);
  } else if (process.platform === "win32") {
    await execFileP("schtasks", ["/End", "/TN", windowsTaskName(commandName)]).catch(() => undefined);
    await execFileP("schtasks", ["/Run", "/TN", windowsTaskName(commandName)]);
  } else {
    throw new Error(`restart is not supported on ${process.platform}`);
  }
  console.log(`service restarted; it will relaunch using ${names.packageName}@latest`);
}

export async function killRunningDaemons(): Promise<number> {
  const candidates = new Set<number>();
  try {
    const state = JSON.parse(await readFile(RUNNING_STATE_PATH, "utf8")) as { pid?: unknown };
    if (typeof state.pid === "number" && state.pid > 0) candidates.add(state.pid);
  } catch {
    // No tracked foreground daemon.
  }

  if (process.platform !== "win32") {
    try {
      const { stdout } = await execFileP("pgrep", ["-f", "agent computer"]);
      for (const line of stdout.split("\n")) {
        const pid = Number.parseInt(line.trim(), 10);
        if (pid > 0) candidates.add(pid);
      }
    } catch {
      // pgrep exits non-zero when no process matches.
    }
  }

  candidates.delete(process.pid);
  if (typeof process.ppid === "number") candidates.delete(process.ppid);

  const victims: number[] = [];
  for (const pid of candidates) {
    try {
      const { stdout } = await execFileP("ps", ["-p", String(pid), "-o", "command="]);
      if (shouldKillDaemonCommand(stdout.trim())) victims.push(pid);
    } catch {
      // Process already exited or cannot be inspected.
    }
  }

  for (const pid of victims) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
  }

  if (victims.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    for (const pid of victims) {
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {
        // SIGTERM already worked.
      }
    }
    console.log(`killed ${victims.length} running daemon process(es)`);
  }

  await rm(RUNNING_STATE_PATH, { force: true });
  return victims.length;
}

export async function stopService(commandName: CommandName = "king-ai"): Promise<void> {
  if (isServiceInstalled(commandName)) {
    await uninstallService(commandName);
  } else {
    console.log("no background service installed; killing any running daemon process directly");
  }
  const killed = await killRunningDaemons();
  console.log(`stopped; killed ${killed} foreground daemon process(es)`);
}

export async function printStatus(commandName: CommandName = "king-ai"): Promise<void> {
  const names = serviceNames(commandName);
  const cfg = await loadConfig();
  console.log(`cli:     ${names.displayName} ${CURRENT_VERSION} (this command)`);
  console.log(cfg ? `paired:  computer ${cfg.computerId} @ ${cfg.serverUrl}` : `paired:  NO; run: ${names.displayName} agent computer --pair <code>`);

  let livePid: number | null = null;
  if (!isServiceInstalled(commandName)) {
    console.log(`service: not installed; run: ${names.displayName} agent computer --install-service`);
  } else {
    if (process.platform === "darwin") {
      try {
        const { stdout } = await execFileP("launchctl", ["list", names.serviceLabel]);
        const status = parseDarwinLaunchctlStatus(stdout);
        livePid = status.pid;
        console.log(
          livePid
            ? `service: installed; running (pid ${livePid})`
            : `service: installed; NOT running${status.lastExitStatus != null ? ` (last exit ${status.lastExitStatus})` : ""}`
        );
      } catch {
        console.log(`service: installed; not loaded (try: launchctl load ${darwinPlistPath(commandName)})`);
      }
    } else if (process.platform === "linux") {
      const active = await execFileP("systemctl", ["--user", "is-active", names.serviceUnit])
        .then((result) => result.stdout.trim())
        .catch(() => "inactive");
      const pidText = await execFileP("systemctl", ["--user", "show", names.serviceUnit, "-p", "MainPID", "--value"])
        .then((result) => result.stdout)
        .catch(() => "");
      livePid = parseLinuxMainPid(pidText);
      console.log(`service: installed; ${active}${livePid ? ` (pid ${livePid})` : ""}`);
    } else if (process.platform === "win32") {
      const stdout = await execFileP("schtasks", ["/Query", "/TN", windowsTaskName(commandName), "/V", "/FO", "LIST"])
        .then((result) => result.stdout)
        .catch(() => "");
      const status = parseWindowsTaskStatus(stdout);
      console.log(`service: installed; ${status.status ?? "unknown"}${status.lastResult ? ` (last result ${status.lastResult})` : ""}`);
    }
  }

  const running = await resolveRunningVersion(livePid, commandName);
  const state = await readRunningState();
  if (running) {
    console.log(
      `running: ${names.displayName} ${running}${
        running === CURRENT_VERSION ? " (same as this cli)" : " (differs from this cli; run --restart to pick up latest)"
      }`
    );
  } else {
    console.log("running: unknown; run --restart to start it and record the version");
  }
  const snapshot = formatRunningStateSnapshot(state);
  if (snapshot) console.log(snapshot);
  console.log(`logs:    ${process.platform === "linux" ? `journalctl --user -u ${names.serviceUnit} -f` : daemonLogPath()}`);
}

export async function resolveRunningVersion(livePid?: number | null, commandName: CommandName = "king-ai"): Promise<string> {
  const names = serviceNames(commandName);
  try {
    const state = JSON.parse(await readFile(RUNNING_STATE_PATH, "utf8")) as { version?: string; pid?: number };
    if (typeof state.version === "string" && state.version && (livePid == null || state.pid === livePid)) return state.version;
  } catch {
    // Fall through to log parsing.
  }
  try {
    const text =
      process.platform === "linux"
        ? (await execFileP("journalctl", ["--user", "-u", names.serviceUnit, "-n", "400", "--no-pager"])).stdout
        : await readFile(daemonLogPath(), "utf8");
    const matches = [...text.matchAll(new RegExp(`${names.displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (\\d+\\.\\d+\\.\\d+) starting`, "g"))];
    return matches.at(-1)?.[1] ?? "";
  } catch {
    return "";
  }
}

export async function readRunningState(path = RUNNING_STATE_PATH): Promise<RunningState | null> {
  try {
    const state = JSON.parse(await readFile(path, "utf8")) as RunningState;
    return typeof state.version === "string" && typeof state.pid === "number" ? state : null;
  } catch {
    return null;
  }
}

export function updateRunningStateData(
  previous: RunningState | null,
  patch: Partial<Omit<RunningState, "events">> & { event?: RunningEvent }
): RunningState {
  const base: RunningState = previous ?? { version: CURRENT_VERSION, pid: process.pid, startedAt: new Date().toISOString() };
  const events = [...(base.events ?? [])];
  if (patch.event) events.push(patch.event);
  return {
    ...base,
    ...patch,
    events: events.slice(-50)
  };
}

export async function writeRunningState(patch: Partial<Omit<RunningState, "events">> & { event?: RunningEvent } = {}): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  const previous = await readRunningState();
  await writeFile(
    RUNNING_STATE_PATH,
    JSON.stringify(updateRunningStateData(previous, {
      version: CURRENT_VERSION,
      pid: process.pid,
      startedAt: previous?.startedAt ?? new Date().toISOString(),
      ...patch
    }), null, 2),
    "utf8"
  );
}

export function recordRunningState(patch: Partial<Omit<RunningState, "events">> & { event?: RunningEvent }): void {
  void writeRunningState(patch).catch(() => undefined);
}

export function formatRecentRunningEvents(state: RunningState | null, max = 10): string {
  const events = state?.events?.slice(-max) ?? [];
  if (events.length === 0) return "";
  return [
    "recent daemon events:",
    ...events.map((event) => `  ${event.at} ${event.kind}${event.detail ? `: ${event.detail}` : ""}`)
  ].join("\n");
}

export function runningEventCategory(kind: string): RunningEventCategory {
  if (/^agent\./.test(kind)) return kind.includes("budget") ? "budget" : "agent";
  if (/^(turn|agenda|wake)\./.test(kind)) return "turn";
  if (/budget/.test(kind)) return "budget";
  if (/^(daemon|heartbeat|service)\./.test(kind)) return "daemon";
  return "other";
}

export function groupRunningEvents(events: RunningEvent[] = [], maxPerCategory = 4): Record<RunningEventCategory, RunningEvent[]> {
  const grouped: Record<RunningEventCategory, RunningEvent[]> = {
    agent: [],
    turn: [],
    budget: [],
    daemon: [],
    other: []
  };
  for (const event of events) {
    grouped[runningEventCategory(event.kind)].push(event);
  }
  for (const key of Object.keys(grouped) as RunningEventCategory[]) {
    grouped[key] = grouped[key].slice(-maxPerCategory);
  }
  return grouped;
}

export function formatRunningEventSummary(state: RunningState | null, maxPerCategory = 4): string {
  if (!state?.events?.length) return "";
  const grouped = groupRunningEvents(state.events, maxPerCategory);
  const lines = ["events by category:"];
  for (const category of ["agent", "turn", "budget", "daemon", "other"] as RunningEventCategory[]) {
    const events = grouped[category];
    if (events.length === 0) continue;
    lines.push(`  ${category}:`);
    for (const event of events) {
      lines.push(`    - ${event.at} ${event.kind}${event.detail ? `: ${event.detail}` : ""}`);
    }
  }
  return lines.length === 1 ? "" : lines.join("\n");
}

export function formatRunningStateSnapshot(state: RunningState | null, eventMax = 5): string {
  if (!state) return "";
  const lines: string[] = [];
  if (state.startedAt) lines.push(`started: ${state.startedAt}${state.pid ? ` (pid ${state.pid})` : ""}`);
  if (state.lastHeartbeatAt) lines.push(`heartbeat: ${state.lastHeartbeatAt}`);
  if (state.lastSyncAt) lines.push(`agent sync: ${state.lastSyncAt}`);
  if (state.capabilities?.workspaces) {
    lines.push(`workspaces: ${state.capabilities.workspaces.length ? state.capabilities.workspaces.join(", ") : "(none)"}`);
  }
  if (state.agents?.length) {
    lines.push("agents:");
    for (const agent of state.agents) {
      lines.push(`  - ${agent.id} ${agent.name} on ${agent.engine}${agent.lifecycle ? ` lifecycle=${agent.lifecycle}` : ""}${agent.status ? ` status=${agent.status}` : ""}${agent.model ? ` model=${agent.model}` : ""}${agent.workspaceRoot ? ` workspace=${agent.workspaceRoot}` : ""}`);
      const usage = formatAgentRunStats(agent.runStats);
      if (usage) lines.push(`    usage: ${usage}`);
      const budget = formatTokenBudgetCheck(agent.tokenBudget);
      if (budget) lines.push(`    token budget: ${budget}`);
      if (agent.remediation) {
        lines.push(`    remediation: ${agent.remediation.summary}`);
        for (const action of agent.remediation.actions) lines.push(`      - ${action}`);
      }
      for (const warning of agent.configWarnings ?? []) {
        lines.push(`    config warning: ${warning.code} - ${warning.summary}`);
      }
      if (agent.sharedSkillSnapshot) {
        lines.push(`    skill snapshot: ${agent.sharedSkillSnapshot.id} (${agent.sharedSkillSnapshot.skills.join(", ") || "no skills"}) ${agent.sharedSkillSnapshot.manifestPath}`);
      }
      for (const entry of agent.hostHomeEntries ?? []) {
        lines.push(`    host home entry: ${entry.name} -> ${entry.target || "(not linked)"}${entry.linked ? "" : ` (${entry.reason ?? "skipped"})`}`);
      }
      for (const plan of agent.worktreePlans ?? []) {
        lines.push(`    worktree plan: ${plan.repoName} -> ${plan.worktreePath} (${plan.branch})${plan.repoUrl ? ` from ${plan.repoUrl}` : ""}`);
      }
    }
  }
  const events = formatRunningEventSummary(state, eventMax);
  if (events) lines.push(events);
  return lines.join("\n");
}

export function formatWatchSnapshot(state: RunningState | null, now = new Date()): string {
  const lines = [`king-ai watch ${now.toISOString()}`];
  if (!state) {
    lines.push("running: no running.json found; start the daemon with `king-ai agent computer`");
    return lines.join("\n");
  }
  lines.push(`running: ${state.version} pid=${state.pid}`);
  if (state.computerId || state.serverUrl) lines.push(`paired: ${state.computerId ?? "unknown"} @ ${state.serverUrl ?? "unknown"}`);
  const snapshot = formatRunningStateSnapshot(state, 8);
  if (snapshot) lines.push(snapshot);
  return lines.join("\n");
}

export async function watchStatus(intervalMs = Number(process.env.KING_AI_WATCH_INTERVAL_MS) || 2000): Promise<void> {
  const render = async () => {
    process.stdout.write("\x1Bc");
    console.log(formatWatchSnapshot(await readRunningState()));
    console.log("\nPress Ctrl+C to stop.");
  };
  await render();
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => void render(), Math.max(250, intervalMs));
    const stop = () => {
      clearInterval(timer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

export function worktreePlansFromRunningState(state: RunningState | null): WorktreePlan[] {
  const seen = new Set<string>();
  const plans: WorktreePlan[] = [];
  for (const agent of state?.agents ?? []) {
    for (const plan of agent.worktreePlans ?? []) {
      const key = `${plan.repoRoot}\0${plan.worktreePath}\0${plan.branch}`;
      if (seen.has(key)) continue;
      seen.add(key);
      plans.push(plan);
    }
  }
  return plans;
}

export async function prepareWorktrees(options: { execute?: boolean } = {}): Promise<void> {
  const plans = worktreePlansFromRunningState(await readRunningState());
  console.log(formatWorktreePreparationResults(await prepareWorktreePlans(plans, { execute: options.execute }), Boolean(options.execute)));
}

export async function cleanupWorktrees(options: { execute?: boolean } = {}): Promise<void> {
  const plans = worktreePlansFromRunningState(await readRunningState());
  console.log(formatWorktreeCleanupResults(await cleanupWorktreePlans(plans, { execute: options.execute }), Boolean(options.execute)));
}

export async function rotateLogsIfNeeded(logPath = join(CONFIG_DIR, "daemon.log"), maxBytes = LOG_MAX_BYTES): Promise<void> {
  try {
    const st = await stat(logPath);
    if (st.size <= maxBytes) return;
    await rm(`${logPath}.1`, { force: true });
    await rename(logPath, `${logPath}.1`);
    await writeFile(logPath, "", "utf8");
    console.log(`daemon.log exceeded ${Math.round(maxBytes / 1048576)}MB; rotated to daemon.log.1`);
  } catch {
    // No log yet.
  }
}

export async function checkForUpdate(fetchImpl: typeof fetch = fetch, commandName: CommandName = "king-ai"): Promise<string | null> {
  try {
    const res = await fetchImpl(updateRegistryUrl(commandName), {
      headers: { Accept: "application/json" }
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" && versionGt(body.version, CURRENT_VERSION) ? body.version : null;
  } catch {
    return null;
  }
}

export async function tailLogs(commandName: CommandName = "king-ai"): Promise<void> {
  const names = serviceNames(commandName);
  const state = await readRunningState();
  const recent = formatRunningEventSummary(state, 3) || formatRecentRunningEvents(state);
  if (recent) console.log(`${recent}\n`);
  if (process.platform === "linux") {
    await new Promise<void>((resolve) => {
      const child = spawn("journalctl", ["--user", "-u", names.serviceUnit, "-n", "100", "-f"], { stdio: "inherit" });
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });
    return;
  }
  const logPath = daemonLogPath();
  if (!existsSync(logPath)) {
    console.log(`no log at ${logPath} yet; is the service installed and running?`);
    return;
  }
  await new Promise<void>((resolve) => {
    const child = spawn("tail", ["-n", "100", "-f", logPath], { stdio: "inherit" });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

function windowsCmdQuote(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}
