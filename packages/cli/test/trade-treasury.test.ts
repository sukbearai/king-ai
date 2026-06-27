import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildYieldHighContext,
  classifyPriceDropSeverity,
  classifyYieldRiseSeverity,
  formatTreasuryBriefLine,
  parseTreasuryConfig,
  yieldChangeBps
} from "../src/trade/treasury-helpers.js";
import { createRuleB } from "../src/trade/rules/rule-b-treasury.js";

describe("treasury helpers", () => {
  it("converts yield percent move to basis points", () => {
    assert.ok(Math.abs(yieldChangeBps(5.177, 5.1) - 7.7) < 0.01);
  });

  it("classifies TLT selling pressure thresholds", () => {
    const cfg = parseTreasuryConfig({});
    assert.equal(classifyPriceDropSeverity(-0.5, cfg), "none");
    assert.equal(classifyPriceDropSeverity(-1.2, cfg), "warning");
    assert.equal(classifyPriceDropSeverity(-2.5, cfg), "critical");
  });

  it("classifies 30Y yield spike thresholds", () => {
    const cfg = parseTreasuryConfig({});
    assert.equal(classifyYieldRiseSeverity(3, cfg), "none");
    assert.equal(classifyYieldRiseSeverity(6, cfg), "warning");
    assert.equal(classifyYieldRiseSeverity(12, cfg), "critical");
  });

  it("detects new highs and near-high yields", () => {
    const freshHigh = buildYieldHighContext("^TYX", 5.177, 5.15, 5, 5);
    assert.equal(freshHigh.is_new_high, true);
    assert.equal(freshHigh.is_near_high, false);

    const nearHigh = buildYieldHighContext("^TYX", 5.172, 5.177, 5, 5);
    assert.equal(nearHigh.is_new_high, false);
    assert.equal(nearHigh.is_near_high, true);
  });

  it("formats treasury brief lines with macro context", () => {
    const cfg = parseTreasuryConfig({});
    const line = formatTreasuryBriefLine(
      "30年期收益率",
      "^TYX",
      null,
      { symbol: "^TYX", yield_pct: 5.177, change_bps: 8.2, prev_yield_pct: 5.095 },
      buildYieldHighContext("^TYX", 5.177, 5.15, 5, 5),
      cfg
    );
    assert.match(line, /30年期收益率/);
    assert.match(line, /5\.177%/);
    assert.match(line, /刷新5年新高/);
  });
});

describe("treasury rule", () => {
  it("registers rule b", () => {
    const rule = createRuleB();
    assert.equal(rule.ruleKey, "b");
    assert.equal(rule.name, "treasury_stress");
  });
});