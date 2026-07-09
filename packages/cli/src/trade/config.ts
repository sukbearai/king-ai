import { readFile } from "node:fs/promises";
import { TRADE_CONFIG_PATH } from "../paths.js";
import {
  CANONICAL_ALERT_RULES,
  cooldownDefaults,
  normalizeRuleId,
  SLIM_ALERT_RULES,
  type CanonicalRuleId,
} from "./domain.js";

export type TradeConfig = Record<string, unknown>;

export { CANONICAL_ALERT_RULES, SLIM_ALERT_RULES, type CanonicalRuleId };

export class TradeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TradeConfigError";
  }
}

let cachedConfig: TradeConfig | null = null;

export function tradeConfigFile(): string {
  return TRADE_CONFIG_PATH;
}

export function clearTradeConfigCache(): void {
  cachedConfig = null;
}

/**
 * Load trade config. Missing file → empty object (defaults apply).
 * Invalid JSON → TradeConfigError (daemon should fail fast).
 */
export async function loadTradeConfig(force = false): Promise<TradeConfig> {
  if (!force && cachedConfig) return cachedConfig;
  try {
    const raw = await readFile(TRADE_CONFIG_PATH, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new TradeConfigError(`invalid JSON in ${TRADE_CONFIG_PATH}: ${msg}`);
    }
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TradeConfigError(`trade config root must be a JSON object (${TRADE_CONFIG_PATH})`);
    }
    cachedConfig = parsed as TradeConfig;
    return cachedConfig;
  } catch (err) {
    if (err instanceof TradeConfigError) throw err;
    // ENOENT or other read errors → defaults
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

/**
 * Resolve enabled rule list to canonical ids.
 * Unknown ids are skipped (and reported via onUnknown when provided).
 */
export function enabledAlertRules(config: TradeConfig, options?: { onUnknown?: (id: string) => void }): string[] {
  const enabled = dotGet(config, "alerts.enabled", [...CANONICAL_ALERT_RULES]) as unknown;
  const raw = Array.isArray(enabled) ? enabled.map(String) : [...CANONICAL_ALERT_RULES];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of raw) {
    const canonical = normalizeRuleId(id);
    if (!canonical) {
      options?.onUnknown?.(id);
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out.length ? out : [...CANONICAL_ALERT_RULES];
}

export function defaultPollSeconds(config: TradeConfig): number {
  const v = Number(dotGet(config, "alerts.poll_seconds", 120));
  return Number.isFinite(v) && v > 0 ? v : 120;
}

export function confluenceEnabled(config: TradeConfig): boolean {
  if (dotGet(config, "alerts.confluence.enabled", undefined) !== undefined) {
    return dotGet(config, "alerts.confluence.enabled", true) !== false;
  }
  return dotGet(config, "alerts.confluence_enabled", true) !== false;
}

export function confluenceWindowSeconds(config: TradeConfig): number {
  const nested = Number(dotGet(config, "alerts.confluence.window_seconds", NaN));
  if (Number.isFinite(nested) && nested > 0) return nested;
  const v = Number(dotGet(config, "alerts.confluence_window_seconds", 900));
  return Number.isFinite(v) && v > 0 ? v : 900;
}

export function ruleStaggerMs(config: TradeConfig): number {
  const v = Number(dotGet(config, "alerts.rule_stagger_ms", 1000));
  return Number.isFinite(v) && v >= 0 ? v : 1000;
}

/** Global default tick timeout; per-rule meta still applies when this is unset. */
export function globalTickTimeoutMs(config: TradeConfig): number | null {
  const v = Number(dotGet(config, "alerts.tick_timeout_ms", NaN));
  if (Number.isFinite(v) && v > 0) return v;
  return null;
}

export function resolveCooldownConfig(config: TradeConfig): Record<string, number> {
  const overrides = (dotGet(config, "alerts.cooldowns", {}) ?? {}) as Record<string, number>;
  const base = cooldownDefaults();
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) continue;
    const canonical = normalizeRuleId(key) ?? key;
    merged[canonical] = n;
    // also keep raw key so legacy override keys work
    merged[key] = n;
  }
  return merged;
}

export function telegramFromConfig(config: TradeConfig): { botToken: string; chatId: string } {
  const tg = (dotGet(config, "telegram", {}) ?? {}) as Record<string, unknown>;
  return {
    botToken: String(tg.bot_token ?? process.env.TG_BOT_TOKEN ?? ""),
    chatId: String(tg.push_chat_id ?? process.env.TG_PUSH_CHAT_ID ?? ""),
  };
}

/** Light structural validation used by daemon startup (optional strict mode). */
export function validateTradeConfigShape(config: TradeConfig): string[] {
  const warnings: string[] = [];
  const enabled = dotGet(config, "alerts.enabled", null);
  if (enabled != null && !Array.isArray(enabled)) {
    warnings.push("alerts.enabled should be an array of rule ids");
  }
  if (Array.isArray(enabled)) {
    for (const id of enabled) {
      if (!normalizeRuleId(String(id))) {
        warnings.push(`unknown rule id in alerts.enabled: ${String(id)}`);
      }
    }
  }
  return warnings;
}
