import assert from "node:assert/strict";
import { test } from "node:test";
import { SLIM_ALERT_RULES } from "../src/trade/config.js";
import { createRule, listRuleIds } from "../src/trade/rules/registry.js";

test("trade rule registry matches slim stack", () => {
  assert.deepEqual(listRuleIds(), [...SLIM_ALERT_RULES]);
  for (const id of SLIM_ALERT_RULES) {
    const rule = createRule(id);
    assert.ok(rule, `createRule(${id}) failed`);
    assert.ok(rule!.ruleKey);
  }
});