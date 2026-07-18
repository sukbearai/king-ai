/** Canonical trade rule ids, display metadata, and legacy id mapping. */

export type AlertSeverity = "info" | "warning" | "critical";

export interface RuleMeta {
  /** Stable id used in config, state, caps, and audit. */
  id: string;
  /** Historical single-letter / short ids still accepted in config. */
  legacyIds: string[];
  /** Human-facing Chinese/English label in Telegram and logs. */
  displayName: string;
  defaultCooldownSec: number;
  dailyPushCap: number;
  /** Per-rule daemon/verify tick budget when config does not override. */
  defaultTickTimeoutMs: number;
  tags: string[];
}

/** Default slim stack — canonical ids only. */
export const CANONICAL_ALERT_RULES = [
  "treasury",
  "meme_large",
  "stocks",
  "celebrity",
  "ticker_velocity",
  "discord_wba",
  "panews",
] as const;

export type CanonicalRuleId = (typeof CANONICAL_ALERT_RULES)[number];

/** @deprecated Use CANONICAL_ALERT_RULES; kept for import compatibility. */
export const SLIM_ALERT_RULES = CANONICAL_ALERT_RULES;

export const RULE_META: Record<string, RuleMeta> = {
  treasury: {
    id: "treasury",
    legacyIds: ["b"],
    displayName: "美债抛售",
    defaultCooldownSec: 3600,
    dailyPushCap: 4,
    defaultTickTimeoutMs: 60_000,
    tags: ["macro", "treasury"],
  },
  meme_large: {
    id: "meme_large",
    legacyIds: ["e"],
    displayName: "Meme 大额",
    defaultCooldownSec: 600,
    dailyPushCap: 8,
    defaultTickTimeoutMs: 90_000,
    tags: ["meme", "onchain"],
  },
  stocks: {
    id: "stocks",
    legacyIds: ["f"],
    displayName: "股票异动",
    defaultCooldownSec: 3600,
    dailyPushCap: 3,
    defaultTickTimeoutMs: 120_000,
    tags: ["equities"],
  },
  celebrity: {
    id: "celebrity",
    legacyIds: ["t"],
    displayName: "名人推文",
    defaultCooldownSec: 600,
    dailyPushCap: 5,
    defaultTickTimeoutMs: 240_000,
    tags: ["twitter", "alpha"],
  },
  ticker_velocity: {
    id: "ticker_velocity",
    legacyIds: ["tm"],
    displayName: "提及加速",
    defaultCooldownSec: 86_400,
    dailyPushCap: 5,
    defaultTickTimeoutMs: 30_000,
    tags: ["twitter", "ticker"],
  },
  discord_wba: {
    id: "discord_wba",
    legacyIds: [],
    displayName: "王不爱喊单",
    defaultCooldownSec: 300,
    dailyPushCap: 5,
    defaultTickTimeoutMs: 60_000,
    tags: ["discord"],
  },
  panews: {
    id: "panews",
    legacyIds: ["q"],
    displayName: "PANews事件",
    defaultCooldownSec: 86_400,
    dailyPushCap: 5,
    defaultTickTimeoutMs: 120_000,
    tags: ["news"],
  },
  kimpremium: {
    id: "kimpremium",
    legacyIds: [],
    displayName: "韩国杠杆风险",
    defaultCooldownSec: 86_400,
    dailyPushCap: 3,
    defaultTickTimeoutMs: 90_000,
    tags: ["macro", "korea", "leverage"],
  },
};

const LEGACY_TO_CANONICAL: Record<string, string> = {};
const DISPLAY_TO_CANONICAL: Record<string, string> = {};

for (const meta of Object.values(RULE_META)) {
  for (const legacy of meta.legacyIds) {
    LEGACY_TO_CANONICAL[legacy] = meta.id;
  }
  DISPLAY_TO_CANONICAL[meta.displayName] = meta.id;
}

/** Cooldown defaults keyed by canonical id (and legacy aliases for overrides). */
export function cooldownDefaults(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const meta of Object.values(RULE_META)) {
    out[meta.id] = meta.defaultCooldownSec;
    for (const legacy of meta.legacyIds) out[legacy] = meta.defaultCooldownSec;
  }
  return out;
}

/** Normalize any known id (canonical, legacy, or display name) to canonical id. */
export function normalizeRuleId(id: string): string | null {
  const raw = String(id ?? "").trim();
  if (!raw) return null;
  if (RULE_META[raw]) return raw;
  if (LEGACY_TO_CANONICAL[raw]) return LEGACY_TO_CANONICAL[raw]!;
  if (DISPLAY_TO_CANONICAL[raw]) return DISPLAY_TO_CANONICAL[raw]!;
  return null;
}

export function getRuleMeta(id: string): RuleMeta | null {
  const canonical = normalizeRuleId(id);
  return canonical ? (RULE_META[canonical] ?? null) : null;
}

export function dailyPushCapFor(ruleId: string): number {
  return getRuleMeta(ruleId)?.dailyPushCap ?? 10;
}

export function defaultTickTimeoutMsFor(ruleId: string): number {
  return getRuleMeta(ruleId)?.defaultTickTimeoutMs ?? 60_000;
}

export function formatRuleListLabel(id: string): string {
  const meta = getRuleMeta(id);
  if (!meta) return id;
  const legacy = meta.legacyIds.length ? ` (legacy: ${meta.legacyIds.join(", ")})` : "";
  return `${meta.id}${legacy} — ${meta.displayName}`;
}

/** Normalize asset symbol for confluence; empty means "do not participate". */
export function normalizeAsset(asset: string | undefined | null): string {
  return String(asset ?? "")
    .trim()
    .toUpperCase();
}
