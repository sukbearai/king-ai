import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_NAME = "king-ai";
export type CommandName = "king-ai";

export function normalizeCommandName(raw?: string): CommandName {
  return "king-ai";
}

export function commandNameFromProcess(argv0 = process.argv[1]): CommandName {
  return normalizeCommandName(argv0);
}

export function resolveConfigDir(_commandName = commandNameFromProcess()): string {
  return process.env.KING_AI_CONFIG_DIR || join(homedir(), ".king-ai");
}

export const CONFIG_DIR = resolveConfigDir();
export const LEGACY_CONFIG_DIR = join(homedir(), ".king");
export const CONFIG_PATH = join(CONFIG_DIR, "computer.json");
export const LEGACY_CONFIG_PATH = join(LEGACY_CONFIG_DIR, "computer.json");
export const AGENTS_ROOT = join(CONFIG_DIR, "agents");
export const SESSIONS_DIR = join(CONFIG_DIR, "sessions");
export const TRIAGE_DIR = join(CONFIG_DIR, "triage");
export const RUNNING_STATE_PATH = join(CONFIG_DIR, "running.json");
export const HEARTBEAT_PATH = join(CONFIG_DIR, "heartbeat.json");
export const HOST_EVENTS_PATH = join(CONFIG_DIR, "host-events.ndjson");
export const HOST_RUNS_PATH = join(CONFIG_DIR, "host-runs.ndjson");
export const SERVICE_LABEL = "dev.king-ai";
export const CURRENT_VERSION = readPackageVersion();
export const DEFAULT_SERVER = process.env.KING_AI_SERVER_URL || "https://api.king-ai.ai";

function readPackageVersion(): string {
  const candidates = [
    new URL("../../package.json", import.meta.url),
    new URL("../package.json", import.meta.url)
  ];
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof pkg.version === "string" && pkg.version) return pkg.version;
    } catch {
      // Source and built files live at different depths; try the next candidate.
    }
  }
  return "0.0.0";
}
