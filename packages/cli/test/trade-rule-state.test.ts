import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AlertState } from "../src/trade/alert-rule.js";
import { RuleStateStore } from "../src/trade/rule-state.js";

describe("RuleStateStore alert cooldowns", () => {
  it("persists cooldown timestamps across load/save", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rule-state-"));
    const path = join(dir, "rule_state.json");
    const store = new RuleStateStore(path);

    const cooldowns: Record<string, number> = {};
    const state = new AlertState({ q: 86400 }, cooldowns);
    assert.equal(state.canAlert("panews_test_1", 60), true);

    await store.saveAlertCooldowns(cooldowns);

    const reloaded = await store.loadAlertCooldowns();
    const state2 = new AlertState({ q: 86400 }, reloaded);
    assert.equal(state2.canAlert("panews_test_1", 60), false);

    await rm(dir, { recursive: true, force: true });
  });
});
