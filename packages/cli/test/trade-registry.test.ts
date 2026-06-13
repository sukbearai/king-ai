import assert from "node:assert/strict";
import { test } from "node:test";
import { createRule, listRuleIds } from "../src/trade/rules/registry.js";

test("trade rule registry includes core production rules", () => {
  const ids = listRuleIds();
  for (const id of ["a", "b", "c", "d", "e", "f", "j", "u", "discord_wba"]) {
    assert.ok(ids.includes(id), `missing rule ${id}`);
    const rule = createRule(id);
    assert.ok(rule, `createRule(${id}) failed`);
    assert.equal(rule!.ruleKey, id === "discord_wba" ? "discord_wba" : id);
  }
});