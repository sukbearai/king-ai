import {
  confluenceEnabled,
  defaultPollSeconds,
  dotGet,
  enabledAlertRules,
  loadTradeConfig,
  ruleStaggerMs,
} from "./config.js";
import { AlertState, COOLDOWN_DEFAULTS, runRuleTick, type AlertRule } from "./alert-rule.js";
import { getRuleStateStore } from "./rule-state.js";
import { loadEnabledRules } from "./rules/registry.js";

export interface UnifiedRuleSchedulerOptions {
  pushTg?: boolean;
  dryRun?: boolean;
  onStatus?: (line: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Single poll loop: run enabled rules sequentially with stagger, then wait poll_seconds. */
export async function runUnifiedRuleScheduler(options: UnifiedRuleSchedulerOptions = {}): Promise<void> {
  const config = await loadTradeConfig();
  const pollSeconds = defaultPollSeconds(config);
  const staggerMs = ruleStaggerMs(config);
  const enabledIds = enabledAlertRules(config);
  const rules = await loadEnabledRules(enabledIds);
  const store = getRuleStateStore();
  const sharedCooldowns = await store.loadAlertCooldowns();
  const cdOverrides = (dotGet(config, "alerts.cooldowns", {}) ?? {}) as Record<string, number>;
  const cooldownConfig = { ...COOLDOWN_DEFAULTS, ...cdOverrides };
  const states = new Map<string, AlertState>(
    rules.map((rule) => [rule.ruleKey, new AlertState(cooldownConfig, sharedCooldowns)]),
  );
  const useConfluence = confluenceEnabled(config);
  const confluenceWindow = Number(dotGet(config, "alerts.confluence_window_seconds", 900)) || 900;

  process.stderr.write(
    `[rule-scheduler] unified poll — rules=[${rules.map((r) => r.ruleKey).join(",")}] interval=${pollSeconds}s stagger=${staggerMs}ms\n`,
  );

  for (;;) {
    for (const rule of rules) {
      const state = states.get(rule.ruleKey)!;
      await runRuleTick(rule, state, {
        pushTg: options.pushTg,
        dryRun: options.dryRun,
        onStatus: options.onStatus,
        confluenceEnabled: useConfluence,
        confluenceWindowSeconds: confluenceWindow,
      });
      if (staggerMs > 0) await sleep(staggerMs);
    }
    await store.saveAlertCooldowns(sharedCooldowns);
    await sleep(pollSeconds * 1000);
  }
}
