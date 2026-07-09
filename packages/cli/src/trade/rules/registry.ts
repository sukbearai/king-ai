import type { AlertRule } from "../alert-rule.js";
import { SLIM_ALERT_RULES } from "../config.js";
import { SLIM_RULE_REGISTRY } from "./registry-slim.js";

export { SLIM_RULE_REGISTRY } from "./registry-slim.js";

export function listSlimRuleIds(): string[] {
  return [...SLIM_ALERT_RULES];
}

export function listRuleIds(): string[] {
  return Object.keys(SLIM_RULE_REGISTRY).sort();
}

export function createRule(id: string): AlertRule | null {
  const factory = SLIM_RULE_REGISTRY[id];
  return factory ? factory() : null;
}

export async function createRuleAsync(id: string): Promise<AlertRule | null> {
  return createRule(id);
}

export async function loadEnabledRules(ids: string[]): Promise<AlertRule[]> {
  const rules: AlertRule[] = [];
  for (const id of ids) {
    const rule = createRule(id);
    if (rule) rules.push(rule);
  }
  return rules;
}
