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
export const CONFIG_PATH = join(CONFIG_DIR, "computer.json");
export const AGENTS_ROOT = join(CONFIG_DIR, "agents");
// Durable, agent-writable skill store kept OUTSIDE the ephemeral agent homes so learned skills
// survive home resets/reinstalls and get reinstalled into each home on the next start.
export const LEARNED_SKILLS_ROOT = join(CONFIG_DIR, "learned-skills");
export function learnedSkillsDir(agentId: string): string {
  return join(LEARNED_SKILLS_ROOT, agentId);
}
export const SESSIONS_DIR = join(CONFIG_DIR, "sessions");
export const TRIAGE_DIR = join(CONFIG_DIR, "triage");
export const RUNNING_STATE_PATH = join(CONFIG_DIR, "running.json");
export const HEARTBEAT_PATH = join(CONFIG_DIR, "heartbeat.json");
export const HOST_EVENTS_PATH = join(CONFIG_DIR, "host-events.ndjson");
export const HOST_RUNS_PATH = join(CONFIG_DIR, "host-runs.ndjson");
export const SERVICE_LABEL = "dev.king-ai";
export const CURRENT_VERSION = "0.2.51";
export const DEFAULT_SERVER = process.env.KING_AI_SERVER_URL || "https://king-ai.congrongtech.cn";
