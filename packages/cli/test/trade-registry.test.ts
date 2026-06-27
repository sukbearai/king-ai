import assert from "node:assert/strict";
import { test } from "node:test";
import { SLIM_ALERT_RULES } from "../src/trade/config.js";
import { createRule, listRuleIds } from "../src/trade/rules/registry.js";

test("trade rule registry exposes all registered rules", () => {
  const ids = listRuleIds();
  assert.ok(ids.includes("b"));
  for (const id of ids) {
    const rule = createRule(id);
    assert.ok(rule, `createRule(${id}) failed`);
    assert.ok(rule!.ruleKey);
  }
  for (const id of SLIM_ALERT_RULES) {
    assert.ok(ids.includes(id), `default slim rule ${id} missing from registry`);
  }
});
