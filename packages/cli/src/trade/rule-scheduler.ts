import {
  confluenceEnabled,
  confluenceWindowSeconds,
  defaultPollSeconds,
  enabledAlertRules,
  loadTradeConfig,
  resolveCooldownConfig,
  ruleStaggerMs,
} from "./config.js";
import { AlertState, runRuleTick, type AlertRule, type RunRuleTickOptions } from "./alert-rule.js";
import { getTradeStore } from "./store.js";
import { loadEnabledRules } from "./rules/registry.js";

export interface UnifiedRuleSchedulerOptions {
  pushTg?: boolean;
  dryRun?: boolean;
  onStatus?: (line: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runScheduledRuleTick(
  rule: AlertRule,
  state: AlertState,
  options: RunRuleTickOptions,
  saveCooldowns: (cooldowns: Record<string, number>) => Promise<void>,
): Promise<void> {
  await runRuleTick(rule, state, options);
  await saveCooldowns(state.cooldowns);
}

/** Single poll loop: run enabled rules sequentially with stagger + per-tick timeout, then wait poll_seconds. */
export async function runUnifiedRuleScheduler(options: UnifiedRuleSchedulerOptions = {}): Promise<void> {
  const config = await loadTradeConfig();
  const pollSeconds = defaultPollSeconds(config);
  const staggerMs = ruleStaggerMs(config);
  const enabledIds = enabledAlertRules(config, {
    onUnknown: (id) => process.stderr.write(`[rule-scheduler] skipping unknown rule id: ${id}\n`),
  });
  const rules = await loadEnabledRules(enabledIds);
  const store = getTradeStore();
  const sharedCooldowns = await store.loadCooldowns();
  const cooldownConfig = resolveCooldownConfig(config);
  const states = new Map<string, AlertState>(
    rules.map((rule) => [rule.ruleKey, new AlertState(cooldownConfig, sharedCooldowns)]),
  );
  const useConfluence = confluenceEnabled(config);
  const confluenceWindow = confluenceWindowSeconds(config);

  process.stderr.write(
    `[rule-scheduler] unified poll — rules=[${rules.map((r) => r.ruleKey).join(",")}] interval=${pollSeconds}s stagger=${staggerMs}ms\n`,
  );

  for (;;) {
    for (const rule of rules) {
      const state = states.get(rule.ruleKey)!;
      // runRuleTick isolates timeout/errors into heartbeat; never abort the round
      await runScheduledRuleTick(
        rule,
        state,
        {
          pushTg: options.pushTg,
          dryRun: options.dryRun,
          onStatus: options.onStatus,
          confluenceEnabled: useConfluence,
          confluenceWindowSeconds: confluenceWindow,
        },
        (cooldowns) => store.saveCooldowns(cooldowns),
      );
      if (staggerMs > 0) await sleep(staggerMs);
    }
    await sleep(pollSeconds * 1000);
  }
}
