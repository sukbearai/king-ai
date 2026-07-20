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
/** Trade runtime root (~/.king-ai/trade/). */
export const TRADE_DIR = join(CONFIG_DIR, "trade");
export const TRADE_CONFIG_PATH = process.env.KING_AI_TRADE_CONFIG || join(CONFIG_DIR, "trade_config.json");
export const TRADE_ALERT_DIR = join(TRADE_DIR, "alerts");
export const TRADE_STATE_DIR = join(TRADE_DIR, "state");
export const TRADE_LOG_DIR = join(TRADE_DIR, "logs");
export const TRADE_SCRATCHPAD_PATH = join(TRADE_DIR, "scratchpad.json");
/** PANews skill CLI bundled with trade runtime. */
export const TRADE_PANEWS_CLI_PATH = join(TRADE_DIR, "skills", "panews", "cli.mjs");
export const TRADE_RULE_STATE_PATH = join(TRADE_STATE_DIR, "rule_state.json");
export const TRADE_KIMPREMIUM_STATE_PATH = join(TRADE_STATE_DIR, "kimpremium_latest.json");
export const TRADE_KIMPREMIUM_SNAPSHOTS_PATH = join(TRADE_STATE_DIR, "kimpremium_snapshots.jsonl");
/** Single-instance lock for `king-ai trade daemon`. */
export const TRADE_DAEMON_PID_PATH = join(TRADE_STATE_DIR, "daemon.pid");
/** JSONL alert audit log written by trade rules. */
export const TRADE_ALERT_LOG_PATH = process.env.KING_AI_ALERT_LOG || join(TRADE_ALERT_DIR, "alert_log.jsonl");
/** JSONL cache of T+4h / T+24h forward outcomes for trade signal-quality. */
export const TRADE_SIGNAL_OUTCOMES_PATH = join(TRADE_STATE_DIR, "signal_outcomes.jsonl");
export const TRADE_TWITTER_CACHE_PATH = join(TRADE_STATE_DIR, "twitter_cache.jsonl");
export const TRADE_MENTIONS_DB_PATH = join(TRADE_STATE_DIR, "twitter_mentions.db");
export const TRADE_WATCHDOG_LOG_PATH = join(TRADE_LOG_DIR, "watchdog.log");
export const TRADE_WATCHDOG_HEALTH_PATH = join(TRADE_LOG_DIR, "watchdog_health_state.txt");
export const TRADE_WATCHDOG_SERVICE_PATH = join(TRADE_LOG_DIR, "watchdog_service_state.json");
export const SERVICE_LABEL = "dev.king-ai";
/** LaunchAgent label for `king-ai trade daemon` background supervisor. */
export const TRADE_SERVICE_LABEL = "dev.king-ai-trade";
export const CURRENT_VERSION = "0.3.12";
export const DEFAULT_SERVER = process.env.KING_AI_SERVER_URL || "https://king-ai.congrongtech.cn";
