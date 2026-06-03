import { homedir } from "node:os";
import { join } from "node:path";

export const APP_NAME = "king";
export function commandNameFromProcess(_argv0 = process.argv[1]): "king" {
  return "king";
}

export function resolveConfigDir(_commandName = commandNameFromProcess()): string {
  return process.env.KING_CONFIG_DIR || join(homedir(), ".king");
}

export const CONFIG_DIR = resolveConfigDir();
export const CONFIG_PATH = join(CONFIG_DIR, "computer.json");
export const AGENTS_ROOT = join(CONFIG_DIR, "agents");
export const SESSIONS_DIR = join(CONFIG_DIR, "sessions");
export const TRIAGE_DIR = join(CONFIG_DIR, "triage");
export const RUNNING_STATE_PATH = join(CONFIG_DIR, "running.json");
export const HEARTBEAT_PATH = join(CONFIG_DIR, "heartbeat.json");
export const HOST_EVENTS_PATH = join(CONFIG_DIR, "host-events.ndjson");
export const HOST_RUNS_PATH = join(CONFIG_DIR, "host-runs.ndjson");
export const SERVICE_LABEL = "dev.king";
export const CURRENT_VERSION = "0.1.0";
export const DEFAULT_SERVER = process.env.KING_SERVER_URL || "https://api.king.ai";
