import assert from "node:assert/strict";
import { test } from "node:test";
import {
  engineInstallAdvice,
  engineRemediationAdvice,
  formatRemediationAdvice,
  formatRemediationBlock
} from "../src/remediation.js";

test("engineInstallAdvice renders missing PATH remediation", () => {
  const advice = engineInstallAdvice("codex");
  assert.equal(advice.category, "missing_engine");
  assert.equal(advice.severity, "error");
  assert.match(formatRemediationBlock(advice), /codex CLI is not on PATH/);
  assert.match(formatRemediationBlock(advice), /king-ai agent computer --doctor/);
});

test("engineRemediationAdvice classifies auth, quota, rate, context, and unknown failures", () => {
  assert.equal(engineRemediationAdvice("claude", "not logged in").category, "auth");
  assert.equal(engineRemediationAdvice("codex", "usage limit reached").category, "quota");
  assert.equal(engineRemediationAdvice("codex", "HTTP 429 too many requests").category, "rate_limit");
  assert.equal(engineRemediationAdvice("codex", "context_length_exceeded").category, "context");
  assert.equal(engineRemediationAdvice("codex", "unpaired surrogate").category, "session");
  assert.equal(engineRemediationAdvice("codex", "process exited with code 2").category, "unknown");
});

test("formatRemediationAdvice keeps a compact hint", () => {
  const text = formatRemediationAdvice(engineRemediationAdvice("codex", "usage limit reached"));
  assert.match(text, /Codex|codex/);
  assert.match(text, /quota|billing|credits/);
  assert.match(text, /doctor/);
});
