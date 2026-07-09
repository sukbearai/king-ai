import assert from "node:assert/strict";
import { test } from "node:test";
import { SLIM_ALERT_RULES } from "../src/trade/config.js";
import { createRule, listRuleIds } from "../src/trade/rules/registry.js";

test("trade rule registry exposes all registered rules", () => {
  const ids = listRuleIds();
  assert.ok(ids.includes("treasury"));
  assert.ok(ids.includes("panews"));
  for (const id of ids) {
    const rule = createRule(id);
    assert.ok(rule, `createRule(${id}) failed`);
    assert.ok(rule!.ruleKey);
  }
  for (const id of SLIM_ALERT_RULES) {
    assert.ok(ids.includes(id), `default slim rule ${id} missing from registry`);
  }
});

test("legacy rule ids resolve to the same factories", () => {
  assert.equal(createRule("b")?.ruleKey, "treasury");
  assert.equal(createRule("e")?.ruleKey, "meme_large");
  assert.equal(createRule("f")?.ruleKey, "stocks");
  assert.equal(createRule("t")?.ruleKey, "celebrity");
  assert.equal(createRule("tm")?.ruleKey, "ticker_velocity");
  assert.equal(createRule("q")?.ruleKey, "panews");
  assert.equal(createRule("discord_wba")?.ruleKey, "discord_wba");
});
