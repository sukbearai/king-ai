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
export const CURRENT_VERSION = "0.2.18";
export const DEFAULT_SERVER = process.env.KING_AI_SERVER_URL || "https://api.king-ai.ai";
