import { readFile } from "node:fs/promises";
import { TRADE_CONFIG_PATH } from "../paths.js";

export type TradeConfig = Record<string, unknown>;

let cachedConfig: TradeConfig | null = null;

export function tradeConfigFile(): string {
  return TRADE_CONFIG_PATH;
}

export async function loadTradeConfig(force = false): Promise<TradeConfig> {
  if (!force && cachedConfig) return cachedConfig;
  try {
    const raw = await readFile(TRADE_CONFIG_PATH, "utf8");
    cachedConfig = JSON.parse(raw) as TradeConfig;
    return cachedConfig;
  } catch {
    cachedConfig = {};
    return cachedConfig;
  }
}

export function dotGet(config: TradeConfig, path: string, fallback?: unknown): unknown {
  let cur: unknown = config;
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object") return fallback;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur ?? fallback;
}

/** Default slim stack: OpenCLI + tg + local agent + Yahoo. */
export const SLIM_ALERT_RULES = ["b", "e", "f", "t", "tm", "discord_wba", "q"] as const;

export function enabledAlertRules(config: TradeConfig): string[] {
  const enabled = dotGet(config, "alerts.enabled", [...SLIM_ALERT_RULES]) as unknown;
  return Array.isArray(enabled) ? enabled.map(String) : [...SLIM_ALERT_RULES];
}

export function defaultPollSeconds(config: TradeConfig): number {
  const v = Number(dotGet(config, "alerts.poll_seconds", 120));
  return Number.isFinite(v) && v > 0 ? v : 120;
}

export function confluenceEnabled(config: TradeConfig): boolean {
  return dotGet(config, "alerts.confluence_enabled", true) !== false;
}

export function ruleStaggerMs(config: TradeConfig): number {
  const v = Number(dotGet(config, "alerts.rule_stagger_ms", 1000));
  return Number.isFinite(v) && v >= 0 ? v : 1000;
}

export function telegramFromConfig(config: TradeConfig): { botToken: string; chatId: string } {
  const tg = (dotGet(config, "telegram", {}) ?? {}) as Record<string, unknown>;
  return {
    botToken: String(tg.bot_token ?? process.env.TG_BOT_TOKEN ?? ""),
    chatId: String(tg.push_chat_id ?? process.env.TG_PUSH_CHAT_ID ?? ""),
  };
}
