/**
 * TradeStore — single facade over durable trade state.
 * Internals still use rule_state.json + scratchpad.json; callers should prefer this API.
 */

import { appendJsonl } from "../jsonl.js";
import { TRADE_ALERT_LOG_PATH } from "../paths.js";
import type { Alert } from "./alert-rule.js";
import { getRuleStateStore, type RuleStateStore } from "./rule-state.js";
import { getScratchpad, type MarketRegime, type Scratchpad } from "./scratchpad.js";

export interface TradeStore {
  claimCooldown(key: string, sec: number, cooldowns: Record<string, number>): boolean;
  loadCooldowns(): Promise<Record<string, number>>;
  saveCooldowns(cooldowns: Record<string, number>): Promise<void>;
  recordSignal(ruleKey: string, symbol: string, direction: string, severity: string, volState?: string): Promise<void>;
  checkConfluence(
    asset: string,
    windowSeconds: number,
  ): Promise<Array<{ ruleKey: string; direction: string; severity: string; volState: string }>>;
  getDailyPushCount(ruleId: string): Promise<number>;
  bumpDailyPush(ruleId: string): Promise<number>;
  setHeartbeat(
    ruleKey: string,
    heartbeat: { ruleName: string; lastCheck: number; status: string; durationMs: number },
  ): Promise<void>;
  getRegime(): Promise<MarketRegime>;
  setRegime(regime: MarketRegime, reason?: string, source?: string): Promise<void>;
  appendAlertAudit(row: Record<string, unknown>): Promise<void>;
  /** Escape hatch for advanced mutators still on RuleStateStore. */
  ruleState: RuleStateStore;
  scratchpad: Scratchpad;
}

function claimCooldown(key: string, sec: number, cooldowns: Record<string, number>): boolean {
  const now = Date.now() / 1000;
  const last = cooldowns[key] ?? 0;
  if (now - last < sec) return false;
  cooldowns[key] = now;
  return true;
}

export function createTradeStore(options?: {
  ruleState?: RuleStateStore;
  scratchpad?: Scratchpad;
  alertLogPath?: string;
}): TradeStore {
  const ruleState = options?.ruleState ?? getRuleStateStore();
  const scratchpad = options?.scratchpad ?? getScratchpad();
  const alertLogPath = options?.alertLogPath ?? TRADE_ALERT_LOG_PATH;

  return {
    ruleState,
    scratchpad,
    claimCooldown,
    loadCooldowns: () => ruleState.loadAlertCooldowns(),
    saveCooldowns: (cooldowns) => ruleState.saveAlertCooldowns(cooldowns),
    recordSignal: (ruleKey, symbol, direction, severity, volState) =>
      ruleState.recordSignal(ruleKey, symbol, direction, severity, volState),
    checkConfluence: (asset, windowSeconds) => ruleState.checkConfluence(asset, windowSeconds),
    getDailyPushCount: (ruleId) => ruleState.getDailyPushCount(ruleId),
    async bumpDailyPush(ruleId) {
      await ruleState.incrementDailyPushCount(ruleId);
      return ruleState.getDailyPushCount(ruleId);
    },
    setHeartbeat(ruleKey, heartbeat) {
      return ruleState
        .update((s) => {
          s.heartbeats[ruleKey] = heartbeat;
        })
        .then(() => undefined);
    },
    getRegime: () => scratchpad.getRegime(),
    setRegime: (regime, reason, source) => scratchpad.setRegime(regime, reason, source),
    appendAlertAudit: (row) => appendJsonl(alertLogPath, row),
  };
}

let singleton: TradeStore | null = null;

export function getTradeStore(): TradeStore {
  if (!singleton) singleton = createTradeStore();
  return singleton;
}

/** Test helper. */
export function resetTradeStoreForTests(): void {
  singleton = null;
}

/** Convenience: audit one structured alert row. */
export async function auditAlert(
  store: TradeStore,
  alert: Alert,
  ruleKey: string,
  extras: Record<string, unknown> = {},
): Promise<void> {
  await store.appendAlertAudit({
    rule: alert.rule,
    rule_id: alert.ruleId,
    rule_key: ruleKey,
    severity: alert.severity,
    title: alert.title,
    detail: alert.detail,
    timestamp: new Date().toISOString(),
    direction: alert.direction,
    strength: alert.strength,
    asset: alert.asset,
    token_contract: alert.tokenContract,
    token_chain: alert.tokenChain,
    token_mcap: alert.tokenMcap,
    ...extras,
  });
}
