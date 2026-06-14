import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { TRADE_LOG_DIR, TRADE_SERVICE_LABEL } from "../paths.js";
import { parseDarwinLaunchctlStatus } from "../service.js";
import { serviceNames } from "../service.js";

const execFileP = promisify(execFile);

export function tradeDaemonLogPath(): string {
  return join(TRADE_LOG_DIR, "daemon.log");
}

export function tradeServiceNames() {
  return {
    packageName: serviceNames().packageName,
    serviceLabel: TRADE_SERVICE_LABEL,
    displayName: "King AI Trade"
  };
}

function resolveNpx(): string {
  const sibling = join(dirname(process.execPath), "npx");
  return existsSync(sibling) ? sibling : "npx";
}

export function resolveTradeDaemonProgramArgs(options: { pushTg?: boolean; cliPath?: string } = {}): string[] {
  const names = tradeServiceNames();
  const tradeArgs = ["trade", "daemon", ...(options.pushTg ? ["--push-tg"] : [])];

  const envCli = options.cliPath ?? process.env.KING_AI_CLI;
  if (envCli) return [process.execPath, envCli, ...tradeArgs];

  const siblingCli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
  if (existsSync(siblingCli)) return [process.execPath, siblingCli, ...tradeArgs];

  const argvCli = process.argv[1];
  if (argvCli && /(?:^|\/)cli\.js$/.test(argvCli) && existsSync(argvCli)) {
    return [process.execPath, argvCli, ...tradeArgs];
  }

  const npx = resolveNpx();
  return [npx, "-y", `${names.packageName}@latest`, ...tradeArgs];
}

function darwinPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${TRADE_SERVICE_LABEL}.plist`);
}

function proxyEnvEntries(): Array<[string, string]> {
  const keys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];
  const entries: Array<[string, string]> = [];
  for (const key of keys) {
    const value = process.env[key];
    if (value) entries.push([key, value]);
  }
  return entries;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildDarwinPlist(args: string[], logPath: string): string {
  const envEntries = [
    ["PATH", process.env.PATH ?? ""],
    ["KING_AI_SUPERVISED", "1"],
    ...proxyEnvEntries()
  ];
  const envXml = envEntries
    .map(([key, value]) => `<key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${TRADE_SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${xmlEscape(a)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
  <key>EnvironmentVariables</key><dict>${envXml}</dict>
</dict></plist>`;
}

export async function installTradeService(options: { pushTg?: boolean } = {}): Promise<void> {
  const names = tradeServiceNames();
  const logPath = tradeDaemonLogPath();
  const args = resolveTradeDaemonProgramArgs({ pushTg: options.pushTg });
  await mkdir(TRADE_LOG_DIR, { recursive: true });

  if (process.platform === "darwin") {
    await mkdir(dirname(darwinPlistPath()), { recursive: true });
    const plistPath = darwinPlistPath();
    await writeFile(plistPath, buildDarwinPlist(args, logPath), "utf8");
    await execFileP("launchctl", ["unload", plistPath]).catch(() => undefined);
    await execFileP("launchctl", ["load", plistPath]);
    console.log(`installed LaunchAgent ${names.serviceLabel}`);
    console.log(`command: ${args.join(" ")}`);
    console.log(`logs:    ${logPath}`);
    return;
  }

  if (process.platform === "linux") {
    const unitPath = join(homedir(), ".config", "systemd", "user", "king-ai-trade.service");
    await mkdir(dirname(unitPath), { recursive: true });
    const unit = `[Unit]
Description=King AI trade daemon
After=network-online.target

[Service]
ExecStart=${args.join(" ")}
Restart=always
RestartSec=5
Environment=PATH=${process.env.PATH ?? ""}
Environment=KING_AI_SUPERVISED=1

[Install]
WantedBy=default.target
`;
    await writeFile(unitPath, unit, "utf8");
    await execFileP("systemctl", ["--user", "daemon-reload"]);
    await execFileP("systemctl", ["--user", "enable", "--now", "king-ai-trade"]);
    console.log("installed systemd --user service king-ai-trade");
    return;
  }

  throw new Error(`trade service installation is not supported on ${process.platform}`);
}

export async function uninstallTradeService(): Promise<void> {
  const names = tradeServiceNames();
  if (process.platform === "darwin") {
    const plistPath = darwinPlistPath();
    await execFileP("launchctl", ["unload", plistPath]).catch(() => undefined);
    await rm(plistPath, { force: true });
    console.log(`removed LaunchAgent ${names.serviceLabel}`);
    return;
  }
  if (process.platform === "linux") {
    const unitPath = join(homedir(), ".config", "systemd", "user", "king-ai-trade.service");
    await execFileP("systemctl", ["--user", "disable", "--now", "king-ai-trade"]).catch(() => undefined);
    await rm(unitPath, { force: true });
    await execFileP("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
    console.log("removed systemd --user service king-ai-trade");
    return;
  }
  throw new Error(`trade service removal is not supported on ${process.platform}`);
}

export function isTradeServiceInstalled(): boolean {
  if (process.platform === "darwin") return existsSync(darwinPlistPath());
  if (process.platform === "linux") {
    return existsSync(join(homedir(), ".config", "systemd", "user", "king-ai-trade.service"));
  }
  return false;
}

export async function restartTradeService(): Promise<void> {
  const names = tradeServiceNames();
  if (!isTradeServiceInstalled()) {
    console.log(`trade service not installed; run: king-ai trade install-service`);
    return;
  }
  if (process.platform === "darwin") {
    const uid = process.getuid?.() ?? 0;
    const plistPath = darwinPlistPath();
    await execFileP("launchctl", ["kickstart", "-k", `gui/${uid}/${names.serviceLabel}`]).catch(async () => {
      await execFileP("launchctl", ["unload", plistPath]).catch(() => undefined);
      await execFileP("launchctl", ["load", plistPath]);
    });
  } else if (process.platform === "linux") {
    await execFileP("systemctl", ["--user", "restart", "king-ai-trade"]);
  }
  console.log(`trade service restarted; it will relaunch using ${names.packageName}@latest`);
}

export async function printTradeServiceStatus(): Promise<void> {
  const names = tradeServiceNames();
  console.log(`trade cli: ${names.displayName} (${names.packageName})`);
  console.log("aux:     twitter-collector, watchdog (built into trade daemon)");

  if (!isTradeServiceInstalled()) {
    console.log("service: not installed; run: king-ai trade install-service --push-tg");
    return;
  }

  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileP("launchctl", ["list", names.serviceLabel]);
      const status = parseDarwinLaunchctlStatus(stdout);
      console.log(
        status.pid
          ? `service: installed; running (pid ${status.pid})`
          : `service: installed; NOT running${status.lastExitStatus != null ? ` (last exit ${status.lastExitStatus})` : ""}`
      );
    } catch {
      console.log(`service: installed; not loaded (try: launchctl load ${darwinPlistPath()})`);
    }
  } else if (process.platform === "linux") {
    const active = await execFileP("systemctl", ["--user", "is-active", "king-ai-trade"])
      .then((result) => result.stdout.trim())
      .catch(() => "inactive");
    console.log(`service: installed; ${active}`);
  }
  console.log(`logs:    ${tradeDaemonLogPath()}`);
}

export async function tailTradeLogs(): Promise<void> {
  const logPath = tradeDaemonLogPath();
  if (process.platform === "linux") {
    await new Promise<void>((resolve) => {
      const child = spawn("journalctl", ["--user", "-u", "king-ai-trade", "-n", "100", "-f"], { stdio: "inherit" });
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });
    return;
  }
  if (!existsSync(logPath)) {
    console.log(`no log at ${logPath} yet; is the trade service installed and running?`);
    return;
  }
  await new Promise<void>((resolve) => {
    const child = spawn("tail", ["-n", "100", "-f", logPath], { stdio: "inherit" });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

export function shouldKillTradeDaemonCommand(command: string): boolean {
  return /trade daemon/.test(command) && !/--(install-service|uninstall-service|status|logs)\b|\bnpx\b/.test(command);
}

export async function killRunningTradeDaemons(): Promise<number> {
  const candidates = new Set<number>();
  if (process.platform !== "win32") {
    try {
      const { stdout } = await execFileP("pgrep", ["-f", "trade daemon"]);
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
      if (shouldKillTradeDaemonCommand(stdout.trim())) victims.push(pid);
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
    console.log(`killed ${victims.length} running trade daemon process(es)`);
  }

  return victims.length;
}