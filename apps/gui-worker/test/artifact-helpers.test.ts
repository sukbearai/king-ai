import assert from "node:assert/strict";
import { test } from "node:test";
import { checkArtifactQuality, formatArtifactQualityCheck } from "../src/artifact-helpers.js";

test("checkArtifactQuality flags non-standard kinds and missing metadata dates", () => {
  const check = checkArtifactQuality({
    kind: "custom_kind",
    path: "domain/category/item",
    source: "estimate",
    confidence: 0.9,
    metadata: {},
  });
  assert.equal(check.valid, false);
  assert.match(formatArtifactQualityCheck(check), /non-standard kind/);
  assert.match(formatArtifactQualityCheck(check), /metadata should include collection date/);
});

test("checkArtifactQuality accepts well-formed standard artifacts", () => {
  const check = checkArtifactQuality({
    kind: "tech_spec",
    path: "platform/runtime/item",
    source: "cross_validated",
    confidence: 0.9,
    metadata: { verified_at: "2026-06-08" },
  });
  assert.equal(check.valid, true);
  assert.equal(check.warnings.length, 0);
});
