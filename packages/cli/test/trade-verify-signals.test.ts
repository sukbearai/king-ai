import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveVerifyBriefSections,
  verifyRuleTimeoutMs,
  verifyStepTimeoutMs,
  withVerifyTimeout,
} from "../src/trade/verify-signals.js";

describe("resolveVerifyBriefSections", () => {
  it("uses configured brief sections and includes market", () => {
    const sections = resolveVerifyBriefSections({
      briefing: { enabled: ["market", "treasury", "stocks", "telegram", "twitter", "unknown"] },
    });
    assert.deepEqual(sections, ["market", "treasury", "stocks", "telegram", "twitter"]);
  });

  it("falls back to all core brief sections when config is missing or invalid", () => {
    assert.deepEqual(resolveVerifyBriefSections({ briefing: { enabled: ["unknown"] } }), [
      "market",
      "stocks",
      "treasury",
      "telegram",
      "twitter",
    ]);
  });
});

describe("verifyStepTimeoutMs", () => {
  it("reads a positive verify timeout and falls back on invalid values", () => {
    assert.equal(verifyStepTimeoutMs({ verify: { step_timeout_ms: 1234 } }), 1234);
    assert.equal(verifyStepTimeoutMs({ verify: { step_timeout_ms: 0 } }), 60_000);
  });
});

describe("verifyRuleTimeoutMs", () => {
  it("uses a longer default budget for celebrity tweet verification", () => {
    assert.equal(verifyRuleTimeoutMs({}, "t"), 240_000);
    assert.equal(verifyRuleTimeoutMs({}, "celebrity"), 240_000);
    assert.equal(verifyRuleTimeoutMs({}, "q"), 120_000);
    assert.equal(verifyRuleTimeoutMs({}, "panews"), 120_000);
  });

  it("lets explicit verify timeout override rule defaults", () => {
    assert.equal(verifyRuleTimeoutMs({ verify: { step_timeout_ms: 90_000 } }, "t"), 90_000);
  });
});

describe("withVerifyTimeout", () => {
  it("fails the step when the timeout is exceeded", async () => {
    await assert.rejects(
      () =>
        withVerifyTimeout("brief:twitter", 1, () => new Promise((resolve) => setTimeout(() => resolve("late"), 20))),
      /brief:twitter timed out after 1ms/,
    );
  });
});
