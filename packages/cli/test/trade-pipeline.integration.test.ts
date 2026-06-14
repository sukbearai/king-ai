import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SLIM_ALERT_RULES } from "../src/trade/config.js";
import { loadEnabledRules, listRuleIds, createRule } from "../src/trade/rules/registry.js";
import { parseTelegramChannels, parseTgRecentMessages } from "../src/trade/morning-brief.js";

describe("slim trade pipeline", () => {
  it("registry exposes only verify-tg rule ids", () => {
    assert.deepEqual(listRuleIds(), [...SLIM_ALERT_RULES]);
    for (const id of SLIM_ALERT_RULES) {
      const rule = createRule(id);
      assert.ok(rule, `missing slim rule ${id}`);
      assert.equal(typeof rule!.check, "function");
    }
  });

  it("loadEnabledRules resolves full slim stack", async () => {
    const rules = await loadEnabledRules([...SLIM_ALERT_RULES]);
    assert.equal(rules.length, SLIM_ALERT_RULES.length);
  });

  it("telegram brief path parses json and channel config", () => {
    const rows = parseTelegramChannels({
      "方程式快讯": "方程式新闻 BWEnews",
      "meme 链上监控": "meme链上监控"
    });
    assert.equal(rows[0]?.chat, "方程式新闻 BWEnews");

    const raw = JSON.stringify({
      ok: true,
      data: [{ content: "headline" }]
    });
    assert.deepEqual(parseTgRecentMessages(raw), ["headline"]);
  });

  it("rule e is tg-only", () => {
    const rule = createRule("e");
    assert.ok(rule);
    assert.equal(rule!.name, "meme_large_buys");
  });
});