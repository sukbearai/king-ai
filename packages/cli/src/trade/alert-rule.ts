import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TRADE_ALERT_LOG_PATH } from "../paths.js";
import {
  buildDeterministicTradeAlertAdvice,
  generateTradeAlertAdvice,
  tradeAlertAdviceEnabled,
  type TradeAlertAdvice,
} from "./alert-advice.js";
import {
  confluenceEnabled,
  confluenceWindowSeconds,
  dotGet,
  globalTickTimeoutMs,
  loadTradeConfig,
  resolveCooldownConfig,
  type TradeConfig,
} from "./config.js";
import { fetchMajorPrices, nowDisplay } from "./data-helpers.js";
import {
  dailyPushCapFor,
  defaultTickTimeoutMsFor,
  getRuleMeta,
  normalizeAsset,
  normalizeRuleId,
  type AlertSeverity,
} from "./domain.js";
import { getTradeStore } from "./store.js";
import { chunkAlertMessages, sendTelegram } from "./telegram.js";
import { formatDisplayTime } from "./time-utils.js";
import { withTimeout } from "./timeout.js";

export type { AlertSeverity };

export interface Alert {
  /** Canonical rule id for caps, audit, and confluence. */
  ruleId: string;
  /** Display label (usually RuleMeta.displayName). */
  rule: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  timestamp?: string;
  direction: number;
  strength: number;
  asset: string;
  tokenContract: string;
  tokenChain: string;
  tokenMcap: number;
  tags: string[];
  /** Set when confluence promoted info → warning. */
  confluencePromoted?: boolean;
  /**
   * Cooldown key claimed via canAlert/tryClaimCooldown for this alert.
   * Used by runRuleTick to roll back claims when TG push is capped or fails.
   * Absent for info-only / non-gated emissions; createAlert does not invent one.
   */
  cooldownKey?: string;
}

export function createAlert(
  partial: Partial<Alert> &
    Pick<Alert, "severity" | "title" | "detail"> &
    ({ ruleId: string } | { rule: string; ruleId?: string }),
): Alert {
  let ruleId = partial.ruleId ? (normalizeRuleId(partial.ruleId) ?? partial.ruleId) : "";
  let rule = partial.rule ?? "";

  if (ruleId) {
    rule = rule || getRuleMeta(ruleId)?.displayName || ruleId;
  } else if (rule) {
    ruleId = normalizeRuleId(rule) ?? rule;
    rule = getRuleMeta(ruleId)?.displayName ?? rule;
  } else {
    ruleId = "unknown";
    rule = "unknown";
  }

  return {
    timestamp: "",
    direction: 0,
    strength: 0,
    asset: "",
    tokenContract: "",
    tokenChain: "",
    tokenMcap: 0,
    tags: [],
    ...partial,
    ruleId,
    rule,
  };
}

export function formatAlert(alert: Alert): string {
  const icons: Record<AlertSeverity, string> = { info: "ℹ️", warning: "⚠️", critical: "🚨" };
  const icon = icons[alert.severity] ?? "📢";
  return `${icon} [${alert.rule}] ${alert.title}\n${alert.detail}`;
}

/** @deprecated Prefer resolveCooldownConfig(config) / cooldownDefaults() from domain. */
export const COOLDOWN_DEFAULTS: Record<string, number> = {
  treasury: 3600,
  meme_large: 600,
  stocks: 3600,
  celebrity: 600,
  ticker_velocity: 86400,
  panews: 86400,
  discord_wba: 300,
  // legacy aliases
  b: 3600,
  e: 600,
  f: 3600,
  t: 600,
  tm: 86400,
  q: 86400,
};

const TG_SEVERITY_ORDER: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };
const MIN_TG_SEVERITY: AlertSeverity = "warning";

let priceCache: { ts: number; prices: Record<string, number> } | null = null;

async function cachedPrices(): Promise<Record<string, number>> {
  const now = Date.now() / 1000;
  if (priceCache && now - priceCache.ts < 30) return priceCache.prices;
  const prices = await fetchMajorPrices();
  priceCache = { ts: now, prices };
  return prices;
}

export class AlertState {
  cooldowns: Record<string, number>;
  cooldownConfig: Record<string, number>;
  /** Per-tick claim ledger for reserve/rollback when TG drop or delivery fails. */
  pendingClaims = new Map<string, { prev: number; cooldownSec: number }>();

  constructor(cooldownConfig: Record<string, number>, sharedCooldowns?: Record<string, number>) {
    this.cooldownConfig = cooldownConfig;
    this.cooldowns = sharedCooldowns ?? {};
  }

  /** Clear per-tick claim ledger; call once at the start of each rule tick. */
  beginTick(): void {
    this.pendingClaims.clear();
  }

  /**
   * Claim-on-success cooldown gate: returns true once and records the timestamp.
   * Prefer this name; `canAlert` is kept as an alias.
   * First successful claim per key per tick is recorded in pendingClaims for rollback.
   */
  tryClaimCooldown(key: string, cooldown?: number): boolean {
    const rulePrefix = key.includes("_") ? key.split("_")[0]! : key;
    const cd =
      cooldown ?? this.cooldownConfig[rulePrefix] ?? this.cooldownConfig[normalizeRuleId(rulePrefix) ?? ""] ?? 300;
    const now = Date.now() / 1000;
    const last = this.cooldowns[key] ?? 0;
    if (now - last < cd) return false;
    if (!this.pendingClaims.has(key)) {
      this.pendingClaims.set(key, { prev: last, cooldownSec: cd });
    }
    this.cooldowns[key] = now;
    return true;
  }

  /** @deprecated Alias of tryClaimCooldown (claim-on-success). */
  canAlert(key: string, cooldown?: number): boolean {
    return this.tryClaimCooldown(key, cooldown);
  }

  /** Refresh a cooldown timestamp without gating. */
  claimCooldown(key: string): void {
    this.cooldowns[key] = Date.now() / 1000;
  }

  /**
   * Soft-release a claim: set last-fire so ~10% of cooldownSec remains.
   * Unclaimed keys are a no-op. Leaves residual throttle so retries are not instant.
   */
  rollbackClaim(key: string): void {
    const entry = this.pendingClaims.get(key);
    if (!entry) return;
    this.cooldowns[key] = Date.now() / 1000 - 0.9 * entry.cooldownSec;
    this.pendingClaims.delete(key);
  }
}

export interface AlertRule {
  readonly name: string;
  /** Canonical rule id. */
  readonly ruleKey: string;
  readonly defaultCooldown: number;
  /** Optional rule-owned source health reported after a successful check call. */
  readonly heartbeatStatus?: () => "ok" | "degraded" | "error";
  check(state: AlertState): Promise<Alert[]> | Alert[];
}

export interface RunRuleLoopOptions {
  pollSeconds?: number;
  pushTg?: boolean;
  dryRun?: boolean;
  runOnce?: boolean;
  onStatus?: (line: string) => void;
  tickTimeoutMs?: number;
}

async function writeAlertsJsonl(alerts: Alert[], ruleKey: string): Promise<void> {
  const store = getTradeStore();
  const prices = await cachedPrices();
  const regime = await store.getRegime();
  for (const alert of alerts) {
    await store.appendAlertAudit({
      rule: alert.rule,
      rule_id: alert.ruleId,
      rule_key: ruleKey,
      severity: alert.severity,
      title: alert.title,
      detail: alert.detail,
      timestamp: new Date().toISOString(),
      prices,
      direction: alert.direction,
      strength: alert.strength,
      asset: alert.asset,
      token_contract: alert.tokenContract,
      token_chain: alert.tokenChain,
      token_mcap: alert.tokenMcap,
      regime,
      confluence_promoted: alert.confluencePromoted === true,
    });
  }
}

export async function filterTgWorthy(alerts: Alert[]): Promise<Alert[]> {
  const store = getTradeStore();
  const minLevel = TG_SEVERITY_ORDER[MIN_TG_SEVERITY];
  const result: Alert[] = [];
  for (const a of alerts) {
    if (TG_SEVERITY_ORDER[a.severity] < minLevel) continue;
    const ruleId = a.ruleId || normalizeRuleId(a.rule) || a.rule;
    if (a.severity === "critical") {
      await store.bumpDailyPush(ruleId);
      result.push(a);
      continue;
    }
    const cap = dailyPushCapFor(ruleId);
    const count = await store.getDailyPushCount(ruleId);
    if (count >= cap) continue;
    await store.bumpDailyPush(ruleId);
    result.push(a);
  }
  return result;
}

export async function buildTgAlertItems(
  alerts: Alert[],
  config: TradeConfig,
  adviceGenerator: (alerts: Alert[]) => Promise<TradeAlertAdvice> = generateTradeAlertAdvice,
): Promise<Array<{ format(): string }>> {
  const formatted = alerts.map((alert) => ({ format: () => formatAlert(alert) }));
  const adviceAlerts = alerts.filter((alert) => !alert.tags.includes("source-health"));
  if (!adviceAlerts.length || !tradeAlertAdviceEnabled(config)) return formatted;

  let advice: TradeAlertAdvice;
  try {
    advice = await adviceGenerator(adviceAlerts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[alert-advice] generator failed, using local fallback: ${message}\n`);
    advice = buildDeterministicTradeAlertAdvice(adviceAlerts);
  }
  formatted.push({ format: () => advice.text });
  return formatted;
}

async function applyRegimeCap(alerts: Alert[]): Promise<void> {
  const regime = await getTradeStore().getRegime();
  if (regime !== "risk_on") return;
  for (const alert of alerts) {
    if (
      alert.direction < 0 &&
      (alert.severity === "warning" || alert.severity === "critical") &&
      !alert.tags.includes("regime_gated")
    ) {
      alert.severity = "info";
    }
  }
}

export function directionLabel(alert: Alert): string {
  if (alert.direction < 0) return "跌破";
  if (alert.direction > 0) return "突破";
  if (alert.title.includes("跌") || alert.title.includes("超卖") || alert.title.includes("下轨")) return "跌破";
  return "突破";
}

/**
 * Promote info alerts when another rule fired on the same normalized asset
 * in the same direction within the window. Empty assets are ignored.
 */
export async function promoteConfluenceAlerts(
  alerts: Alert[],
  ruleKey: string,
  options: { windowSeconds: number; enabled: boolean },
): Promise<void> {
  if (!options.enabled) return;
  const store = getTradeStore();
  for (const alert of alerts) {
    const sym = normalizeAsset(alert.asset);
    if (!sym) continue;

    await store.recordSignal(ruleKey, sym, directionLabel(alert), alert.severity);
    if (alert.severity !== "info") continue;

    const confluence = await store.checkConfluence(sym, options.windowSeconds);
    const other = confluence.filter((c) => c.ruleKey !== ruleKey);
    if (!other.length) continue;

    const curDir = directionLabel(alert);
    if (other.some((c) => c.direction !== curDir)) continue;
    if (other.every((c) => c.volState === "shrink")) continue;

    alert.severity = "warning";
    alert.confluencePromoted = true;
    alert.detail += `\n🔗 多指标共振: ${other.map((c) => c.ruleKey).join(", ")}`;
  }
}

export interface RunRuleTickOptions {
  pushTg?: boolean;
  dryRun?: boolean;
  onStatus?: (line: string) => void;
  confluenceEnabled?: boolean;
  confluenceWindowSeconds?: number;
  tickTimeoutMs?: number;
  /** Test seam; production uses the configured local-agent chain. */
  adviceGenerator?: (alerts: Alert[]) => Promise<TradeAlertAdvice>;
  /** Test seam; production uses telegram.sendTelegram. */
  sendTelegram?: (text: string, config?: TradeConfig) => Promise<boolean>;
  /** When true, rethrow after recording heartbeat (used by scheduler isolation tests). */
  rethrow?: boolean;
}

function resolveTickTimeoutMs(rule: AlertRule, config: TradeConfig, override?: number): number {
  if (override != null && Number.isFinite(override) && override > 0) return override;
  const global = globalTickTimeoutMs(config);
  if (global != null) return global;
  return defaultTickTimeoutMsFor(rule.ruleKey);
}

export async function runRuleTick(rule: AlertRule, state: AlertState, options: RunRuleTickOptions = {}): Promise<void> {
  const config = await loadTradeConfig();
  const store = getTradeStore();
  const alertDir = dirname(TRADE_ALERT_LOG_PATH);
  await mkdir(alertDir, { recursive: true });
  const timeoutMs = resolveTickTimeoutMs(rule, config, options.tickTimeoutMs);
  const deliverTelegram = options.sendTelegram ?? sendTelegram;

  try {
    const t0 = Date.now();
    state.beginTick();
    const alerts = await withTimeout(`rule:${rule.ruleKey}`, timeoutMs, async () => rule.check(state));
    const elapsedMs = Date.now() - t0;

    await store.setHeartbeat(rule.ruleKey, {
      ruleName: rule.name,
      lastCheck: Date.now() / 1000,
      status: rule.heartbeatStatus?.() ?? "ok",
      durationMs: elapsedMs,
    });

    if (!alerts.length) {
      options.onStatus?.(`[${formatDisplayTime(new Date(), "hm")}] ${rule.name} 监控中... 无告警`);
      return;
    }

    await applyRegimeCap(alerts);
    const message = [`🔔 交易告警 — ${nowDisplay()}\n`, ...alerts.flatMap((a) => [formatAlert(a), ""])].join("\n");
    options.onStatus?.(message);

    if (options.dryRun) return;

    await writeFile(join(alertDir, "latest_alert.txt"), message, "utf8");

    const confluenceWindow = options.confluenceWindowSeconds ?? confluenceWindowSeconds(config);
    await promoteConfluenceAlerts(alerts, rule.ruleKey, {
      windowSeconds: confluenceWindow,
      enabled: options.confluenceEnabled !== false && confluenceEnabled(config),
    });
    await writeAlertsJsonl(alerts, rule.ruleKey);

    if (options.pushTg) {
      const tgAlerts = await filterTgWorthy(alerts);
      const tgSet = new Set(tgAlerts);
      // Warning/critical that hit the daily cap never reached TG — soft-release their claim.
      for (const alert of alerts) {
        if (alert.severity !== "warning" && alert.severity !== "critical") continue;
        const key = alert.cooldownKey;
        if (!key || tgSet.has(alert)) continue;
        state.rollbackClaim(key);
      }

      if (tgAlerts.length) {
        const header = `🔔 交易告警 — ${formatDisplayTime(new Date(), "hm")}`;
        const formatted = await buildTgAlertItems(tgAlerts, config, options.adviceGenerator);
        const chunks = chunkAlertMessages(formatted, header);
        let anyFailed = false;
        for (const chunk of chunks) {
          const delivered = await deliverTelegram(chunk, config);
          if (!delivered) {
            anyFailed = true;
            options.onStatus?.(`规则 ${rule.ruleKey} Telegram 投递失败`);
          }
        }
        // Any chunk failure: over-rollback all tgAlerts with keys (10% residual throttles spam).
        if (anyFailed) {
          for (const alert of tgAlerts) {
            if (alert.cooldownKey) state.rollbackClaim(alert.cooldownKey);
          }
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = /timed out/i.test(msg);
    options.onStatus?.(`规则 ${rule.ruleKey} ${isTimeout ? "超时" : "异常"}: ${msg}`);
    await store.setHeartbeat(rule.ruleKey, {
      ruleName: rule.name,
      lastCheck: Date.now() / 1000,
      status: isTimeout ? "timeout" : "error",
      durationMs: 0,
    });
    if (options.rethrow) throw err;
  }
}

export async function runRuleLoop(rule: AlertRule, options: RunRuleLoopOptions = {}): Promise<void> {
  const config = await loadTradeConfig();
  const store = getTradeStore();
  const sharedCooldowns = await store.loadCooldowns();
  const cooldownConfig = resolveCooldownConfig(config);
  const state = new AlertState(cooldownConfig, sharedCooldowns);
  const pollSeconds = options.pollSeconds ?? (Number(dotGet(config, "alerts.poll_seconds", 120)) || 120);
  let lastRegimeCheck = 0;
  const REGIME_INTERVAL = 4 * 3600;

  const maybeUpdateRegime = async () => {
    const now = Date.now() / 1000;
    if (now - lastRegimeCheck < REGIME_INTERVAL) return;
    lastRegimeCheck = now;
    await store.scratchpad.autoDetectRegime();
  };

  await maybeUpdateRegime();

  for (;;) {
    await maybeUpdateRegime();
    await runRuleTick(rule, state, {
      pushTg: options.pushTg,
      dryRun: options.dryRun,
      onStatus: options.onStatus,
      confluenceEnabled: confluenceEnabled(config),
      confluenceWindowSeconds: confluenceWindowSeconds(config),
      tickTimeoutMs: options.tickTimeoutMs,
    });
    if (!options.dryRun) await store.saveCooldowns(sharedCooldowns);
    if (options.runOnce) break;
    await new Promise((r) => setTimeout(r, pollSeconds * 1000));
  }
}
