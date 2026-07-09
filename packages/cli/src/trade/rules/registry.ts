import type { AlertRule } from "../alert-rule.js";
import { CANONICAL_ALERT_RULES, formatRuleListLabel, normalizeRuleId } from "../domain.js";
import { SLIM_RULE_REGISTRY } from "./registry-slim.js";

export { SLIM_RULE_REGISTRY } from "./registry-slim.js";
export { CANONICAL_ALERT_RULES, formatRuleListLabel, normalizeRuleId } from "../domain.js";

export function listSlimRuleIds(): string[] {
  return [...CANONICAL_ALERT_RULES];
}

/** Canonical rule ids only (sorted). */
export function listRuleIds(): string[] {
  return Object.keys(SLIM_RULE_REGISTRY).sort();
}

/** Human-readable lines for `trade alert list`. */
export function listRuleLabels(): string[] {
  return listRuleIds().map((id) => formatRuleListLabel(id));
}

export function createRule(id: string): AlertRule | null {
  const canonical = normalizeRuleId(id);
  if (!canonical) return null;
  const factory = SLIM_RULE_REGISTRY[canonical];
  return factory ? factory() : null;
}

export async function createRuleAsync(id: string): Promise<AlertRule | null> {
  return createRule(id);
}

export async function loadEnabledRules(ids: string[]): Promise<AlertRule[]> {
  const rules: AlertRule[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const rule = createRule(id);
    if (!rule) continue;
    if (seen.has(rule.ruleKey)) continue;
    seen.add(rule.ruleKey);
    rules.push(rule);
  }
  return rules;
}
