import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CONFIG_DIR,
  TRADE_SERVICE_LABEL,
  TRADE_WATCHDOG_DISK_PATH,
  TRADE_WATCHDOG_HEALTH_PATH,
  TRADE_WATCHDOG_LOG_PATH,
  TRADE_WATCHDOG_SERVICE_PATH,
} from "../paths.js";
import { dotGet, loadTradeConfig, type TradeConfig } from "./config.js";
import { sendTelegram } from "./telegram.js";

const execFileP = promisify(execFile);

const LOG_PATH = TRADE_WATCHDOG_LOG_PATH;
const HEALTH_STATE_PATH = TRADE_WATCHDOG_HEALTH_PATH;
const SERVICE_STATE_PATH = TRADE_WATCHDOG_SERVICE_PATH;
const DISK_STATE_PATH = TRADE_WATCHDOG_DISK_PATH;

const MAX_AGE_MINUTES = 30;
const LEAKER_AGE_MINUTES = 5;
const CPU_THRESHOLD = 50;
const LOAD_AVG_ALERT = 15;
const LOAD_AVG_CLEAR = 8;
const HIGH_CPU_PROCS_ALERT = 3;
const SERVICE_ALERT_COOLDOWN = 1800;
const DEFAULT_DISK_THRESHOLDS = {
  warningFreePercent: 15,
  criticalFreePercent: 8,
  recoveryFreePercent: 20,
} as const;

export type DiskHealthState = "clear" | "warning" | "critical";

export interface DiskWatchdogConfig {
  path: string;
  warningFreePercent: number;
  criticalFreePercent: number;
  recoveryFreePercent: number;
}

export interface DiskHealthTransition {
  state: DiskHealthState;
  event: "warning" | "critical" | "recovered" | null;
}

const ORPHAN_PATTERNS = [/shell-snapshots\/snapshot-/, /CODEX_COMPANION_SESSION_ID/, /claude-\d+-cwd/];
const KNOWN_LEAKERS = [/bun\s+.*server\.ts/, /bun\s+run\s+--cwd.*plugins/, /bun.*worker-service\.cjs/];

const MONITORED_SERVICES: Record<string, { keepAlive: boolean; label: string; skipAlert?: boolean }> = {
  [TRADE_SERVICE_LABEL]: { keepAlive: true, label: "King AI Trade Daemon" },
};

export function resolveDiskWatchdogConfig(config: TradeConfig): DiskWatchdogConfig {
  const pathValue = dotGet(config, "watchdog.disk.path", CONFIG_DIR);
  const path = typeof pathValue === "string" && pathValue.trim() ? pathValue.trim() : CONFIG_DIR;
  const warningFreePercent = Number(
    dotGet(config, "watchdog.disk.warning_free_percent", DEFAULT_DISK_THRESHOLDS.warningFreePercent),
  );
  const criticalFreePercent = Number(
    dotGet(config, "watchdog.disk.critical_free_percent", DEFAULT_DISK_THRESHOLDS.criticalFreePercent),
  );
  const recoveryFreePercent = Number(
    dotGet(config, "watchdog.disk.recovery_free_percent", DEFAULT_DISK_THRESHOLDS.recoveryFreePercent),
  );
  const values = [criticalFreePercent, warningFreePercent, recoveryFreePercent];
  const valid =
    values.every((value) => Number.isFinite(value) && value >= 0 && value <= 100) &&
    criticalFreePercent < warningFreePercent &&
    warningFreePercent < recoveryFreePercent;

  return {
    path,
    ...(valid ? { warningFreePercent, criticalFreePercent, recoveryFreePercent } : { ...DEFAULT_DISK_THRESHOLDS }),
  };
}

export function evaluateDiskHealth(
  previous: DiskHealthState,
  freePercent: number,
  config: DiskWatchdogConfig,
): DiskHealthTransition {
  if (previous === "clear") {
    if (freePercent <= config.criticalFreePercent) return { state: "critical", event: "critical" };
    if (freePercent <= config.warningFreePercent) return { state: "warning", event: "warning" };
    return { state: "clear", event: null };
  }

  if (freePercent >= config.recoveryFreePercent) return { state: "clear", event: "recovered" };
  if (freePercent <= config.criticalFreePercent) {
    return { state: "critical", event: previous === "warning" ? "critical" : null };
  }
  return { state: "warning", event: null };
}

function parseElapsed(elapsed: string): number {
  const parts = elapsed.trim().split(/[-:]/);
  if (parts.length === 4) {
    return Number(parts[0]) * 1440 + Number(parts[1]) * 60 + Number(parts[2]);
  }
  if (parts.length === 3) {
    return Number(parts[0]) * 60 + Number(parts[1]);
  }
  if (parts.length === 2) return Number(parts[0]);
  return 0;
}

async function appendLog(lines: string[]): Promise<void> {
  await mkdir(join(LOG_PATH, ".."), { recursive: true });
  await appendFile(LOG_PATH, `${lines.join("\n")}\n`, "utf8");
}

async function findOrphans(): Promise<
  Array<{ pid: number; cpu: number; age_min: number; cmd: string; reason: string }>
> {
  const { stdout } = await execFileP("ps", ["-eo", "pid,ppid,pcpu,etime,command"]);
  const orphans: Array<{ pid: number; cpu: number; age_min: number; cmd: string; reason: string }> = [];
  for (const line of stdout.trim().split("\n").slice(1)) {
    const parts = line.split(/\s+/, 5);
    if (parts.length < 5) continue;
    const pid = Number.parseInt(parts[0] ?? "", 10);
    const ppid = Number.parseInt(parts[1] ?? "", 10);
    const cpu = Number.parseFloat(parts[2] ?? "0");
    const ageMin = parseElapsed(parts[3] ?? "");
    const cmd = parts[4] ?? "";
    if (!pid || pid === process.pid) continue;
    const isOrphan = ORPHAN_PATTERNS.some((p) => p.test(cmd));
    const isLeaker = KNOWN_LEAKERS.some((p) => p.test(cmd));
    const minAge = isLeaker ? LEAKER_AGE_MINUTES : MAX_AGE_MINUTES;
    const orphanedLeaker = isLeaker && ppid === 1;
    if (ageMin < minAge) continue;
    if (!orphanedLeaker && cpu < CPU_THRESHOLD) continue;
    if (isOrphan || isLeaker) {
      orphans.push({ pid, cpu, age_min: ageMin, cmd: cmd.slice(0, 200), reason: isOrphan ? "orphan" : "known_leaker" });
    }
  }
  return orphans;
}

async function killProcess(pid: number): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
    await new Promise((r) => setTimeout(r, 3000));
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {
      return true;
    }
    return true;
  } catch {
    return true;
  }
}

async function readHealthState(): Promise<string> {
  try {
    return (await readFile(HEALTH_STATE_PATH, "utf8")).trim() || "clear";
  } catch {
    return "clear";
  }
}

async function readDiskState(): Promise<DiskHealthState> {
  try {
    const state = (await readFile(DISK_STATE_PATH, "utf8")).trim();
    if (state === "warning" || state === "critical") return state;
  } catch {
    // Missing state means no disk alert has been emitted yet.
  }
  return "clear";
}

async function writeDiskState(state: DiskHealthState): Promise<void> {
  await mkdir(join(DISK_STATE_PATH, ".."), { recursive: true });
  await writeFile(DISK_STATE_PATH, state, "utf8");
}

async function checkDisk(pushTg: boolean): Promise<string[]> {
  const config = await loadTradeConfig();
  const diskConfig = resolveDiskWatchdogConfig(config);
  const stats = await statfs(diskConfig.path, { bigint: true });
  const freeBytes = stats.bavail * stats.bsize;
  const totalBytes = stats.blocks * stats.bsize;
  if (totalBytes <= 0n) throw new Error(`disk check returned zero capacity for ${diskConfig.path}`);

  const freePercent = Number((freeBytes * 10_000n) / totalBytes) / 100;
  const freeGiB = Number(freeBytes) / 1024 ** 3;
  const totalGiB = Number(totalBytes) / 1024 ** 3;
  const previous = await readDiskState();
  const transition = evaluateDiskHealth(previous, freePercent, diskConfig);
  if (transition.state !== previous) await writeDiskState(transition.state);
  if (!transition.event) return [];

  const now = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const usage =
    `Path: ${diskConfig.path}\n` +
    `Free: ${freeGiB.toFixed(1)} GiB / ${totalGiB.toFixed(1)} GiB (${freePercent.toFixed(1)}%)`;
  let message: string;
  if (transition.event === "recovered") {
    message = `[Watchdog] Disk space recovered @ ${now}\n${usage}`;
  } else {
    const threshold = transition.event === "critical" ? diskConfig.criticalFreePercent : diskConfig.warningFreePercent;
    message =
      `[Watchdog] Disk space ${transition.event} @ ${now}\n` + `${usage}\nThreshold: ${threshold.toFixed(1)}% free`;
  }

  if (pushTg) await sendTelegram(message, config);
  return [message];
}

async function checkHealth(pushTg: boolean): Promise<string[]> {
  const [load1, load5, load15] = loadavg();
  const { stdout } = await execFileP("ps", ["-eo", "pid,pcpu,pmem,comm", "-r"]);
  const top: Array<{ pid: number; cpu: number; name: string }> = [];
  for (const line of stdout.trim().split("\n").slice(1, 6)) {
    const parts = line.trim().split(/\s+/, 4);
    if (parts.length < 4) continue;
    top.push({
      pid: Number.parseInt(parts[0] ?? "", 10),
      cpu: Number.parseFloat(parts[1] ?? "0"),
      name: (parts[3] ?? "").split("/").pop()?.slice(0, 30) ?? "",
    });
  }
  const highCpu = top.filter((p) => p.cpu > 80).length;
  const prev = await readHealthState();
  const isHigh = load5 > LOAD_AVG_ALERT || highCpu >= HIGH_CPU_PROCS_ALERT;
  const alerts: string[] = [];
  const now = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  if (isHigh && prev === "clear") {
    const procs = top.map((p) => `  ${p.name} (PID ${p.pid}) — CPU ${p.cpu.toFixed(0)}%`).join("\n");
    alerts.push(
      `[Watchdog] System load alert @ ${now}\n` +
        `Load avg: ${load1.toFixed(1)} / ${load5.toFixed(1)} / ${load15.toFixed(1)}\n` +
        `Top processes:\n${procs}`,
    );
    await writeFile(HEALTH_STATE_PATH, "alerted", "utf8");
  } else if (!isHigh && prev === "alerted" && load5 < LOAD_AVG_CLEAR) {
    alerts.push(`[Watchdog] System recovered @ ${now} — load avg ${load5.toFixed(1)}`);
    await writeFile(HEALTH_STATE_PATH, "clear", "utf8");
  }

  if (pushTg && alerts.length) {
    const config = await loadTradeConfig();
    for (const msg of alerts) await sendTelegram(msg, config);
  }
  return alerts;
}

async function checkServices(pushTg: boolean): Promise<string[]> {
  const { stdout } = await execFileP("launchctl", ["list"]);
  const status = new Map<string, { pid: string; exit: number }>();
  for (const line of stdout.trim().split("\n").slice(1)) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    status.set(parts[2]!.trim(), { pid: parts[0]!.trim(), exit: Number.parseInt(parts[1] ?? "0", 10) });
  }

  let state: Record<string, number> = {};
  try {
    state = JSON.parse(await readFile(SERVICE_STATE_PATH, "utf8")) as Record<string, number>;
  } catch {
    state = {};
  }

  const alerts: string[] = [];
  const now = Date.now();
  for (const [svcId, cfg] of Object.entries(MONITORED_SERVICES)) {
    if (cfg.skipAlert) continue;
    const st = status.get(svcId);
    const running = st && st.pid !== "-" && st.pid !== "0";
    let problem: string | null = null;
    if (cfg.keepAlive && !running) problem = "not running (should be KeepAlive)";
    else if (st && st.exit !== 0 && !running) problem = `last exit code ${st.exit}`;
    if (!problem) {
      delete state[svcId];
      continue;
    }
    if (now - (state[svcId] ?? 0) < SERVICE_ALERT_COOLDOWN * 1000) continue;
    alerts.push(`⚠️ [Watchdog] Service failure\nService: ${cfg.label} (${svcId})\nStatus: ${problem}`);
    state[svcId] = now;
  }

  await mkdir(join(SERVICE_STATE_PATH, ".."), { recursive: true });
  await writeFile(SERVICE_STATE_PATH, JSON.stringify(state), "utf8");

  if (pushTg && alerts.length) {
    const config = await loadTradeConfig();
    for (const msg of alerts) await sendTelegram(msg, config);
  }
  return alerts;
}

export async function runProcessWatchdog(
  options: { kill?: boolean; pushTg?: boolean; log?: boolean; healthOnly?: boolean } = {},
): Promise<number> {
  const timestamp = new Date().toISOString();
  const logLines: string[] = [];

  for (const alert of await checkServices(!!options.pushTg)) {
    process.stderr.write(`${alert}\n`);
    logLines.push(`[${timestamp}] SERVICE: ${alert}`);
  }
  for (const alert of await checkHealth(!!options.pushTg)) {
    process.stderr.write(`${alert}\n`);
    logLines.push(`[${timestamp}] HEALTH: ${alert}`);
  }
  for (const alert of await checkDisk(!!options.pushTg)) {
    process.stderr.write(`${alert}\n`);
    logLines.push(`[${timestamp}] DISK: ${alert}`);
  }

  if (options.healthOnly) {
    if (options.log && logLines.length) await appendLog(logLines);
    return 0;
  }

  const orphans = await findOrphans();
  if (!orphans.length) {
    if (options.log && logLines.length) await appendLog(logLines);
    return 0;
  }

  const tgParts: string[] = [];
  for (const o of orphans) {
    const msg = `[${timestamp}] ${options.kill ? "KILL" : "WOULD_KILL"} PID=${o.pid} CPU=${o.cpu.toFixed(1)}% age=${o.age_min}min reason=${o.reason}`;
    process.stderr.write(`${msg}\n`);
    logLines.push(msg);
    tgParts.push(`PID ${o.pid} (${o.reason}) — CPU ${o.cpu.toFixed(0)}%, running ${o.age_min}min`);
  }

  if (options.kill && options.pushTg && tgParts.length >= 3) {
    const config = await loadTradeConfig();
    await sendTelegram(`🔪 [Watchdog] 清理 ${tgParts.length} 个孤儿进程\n\n${tgParts.join("\n\n")}`, config);
  }

  if (options.kill) {
    for (const o of orphans) {
      const ok = await killProcess(o.pid);
      logLines.push(`  -> ${ok ? "killed" : "FAILED"} PID=${o.pid}`);
    }
  }

  if (options.log) await appendLog(logLines);
  process.stderr.write(`[watchdog] ${orphans.length} orphan(s)\n`);
  return orphans.length;
}
