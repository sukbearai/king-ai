import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AlertState } from "../src/trade/alert-rule.js";
import {
  shouldResendTreasuryYield,
  YIELD_REALERT_MIN_BPS,
  YIELD_REALERT_RESET_BPS,
} from "../src/trade/rules/rule-b-treasury.js";

describe("shouldResendTreasuryYield", () => {
  it("allows first alert when no prior memo", () => {
    assert.equal(
      shouldResendTreasuryYield({
        yieldPct: 5.162,
        severity: "warning",
        isNewHigh: false,
        lastYieldPct: null,
        lastSeverity: null,
      }),
      true,
    );
  });

  it("suppresses same-value resend after cooldown", () => {
    assert.equal(
      shouldResendTreasuryYield({
        yieldPct: 5.162,
        severity: "warning",
        isNewHigh: false,
        lastYieldPct: 5.162,
        lastSeverity: "warning",
      }),
      false,
    );
  });

  it("suppresses sub-2bp drift at same severity", () => {
    // +1bp = +0.01pp
    assert.equal(
      shouldResendTreasuryYield({
        yieldPct: 5.172,
        severity: "warning",
        isNewHigh: false,
        lastYieldPct: 5.162,
        lastSeverity: "warning",
      }),
      false,
    );
  });

  it("resends when yield rises by at least 2bp", () => {
    assert.equal(YIELD_REALERT_MIN_BPS, 2);
    assert.equal(
      shouldResendTreasuryYield({
        yieldPct: 5.182,
        severity: "warning",
        isNewHigh: false,
        lastYieldPct: 5.162,
        lastSeverity: "warning",
      }),
      true,
    );
  });

  it("resends on severity upgrade warning→critical", () => {
    assert.equal(
      shouldResendTreasuryYield({
        yieldPct: 5.162,
        severity: "critical",
        isNewHigh: false,
        lastYieldPct: 5.162,
        lastSeverity: "warning",
      }),
      true,
    );
  });

  it("resends after a deep retracement below the last alerted yield (new episode)", () => {
    assert.equal(YIELD_REALERT_RESET_BPS, 10);
    // Alerted at 5.162, yields fell, later a fresh spike triggers at 4.90.
    assert.equal(
      shouldResendTreasuryYield({
        yieldPct: 4.9,
        severity: "warning",
        isNewHigh: false,
        lastYieldPct: 5.162,
        lastSeverity: "warning",
      }),
      true,
    );
  });

  it("keeps suppressing within a shallow dip of the last alerted yield", () => {
    // -5bp is still the same episode.
    assert.equal(
      shouldResendTreasuryYield({
        yieldPct: 5.112,
        severity: "warning",
        isNewHigh: false,
        lastYieldPct: 5.162,
        lastSeverity: "warning",
      }),
      false,
    );
  });

  it("resends on is_new_high even at same yield", () => {
    assert.equal(
      shouldResendTreasuryYield({
        yieldPct: 5.162,
        severity: "critical",
        isNewHigh: true,
        lastYieldPct: 5.162,
        lastSeverity: "critical",
      }),
      true,
    );
  });
});

describe("AlertState memo for treasury yield", () => {
  it("persists last yield in-memory across checks", () => {
    const state = new AlertState({});
    assert.equal(state.getMemo("treasury_yield_^TYX"), undefined);
    state.setMemo("treasury_yield_^TYX", 5.162);
    state.setMemo("treasury_yield_sev_^TYX", "warning");
    assert.equal(state.getMemo("treasury_yield_^TYX"), 5.162);
    assert.equal(state.getMemo("treasury_yield_sev_^TYX"), "warning");
  });
});
