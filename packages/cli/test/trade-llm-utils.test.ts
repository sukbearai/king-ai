import assert from "node:assert/strict";
import { test } from "node:test";
import { extractJsonFromText } from "../src/trade/llm-utils.js";

test("extractJsonFromText parses fenced JSON array", () => {
  const parsed = extractJsonFromText('prefix\n```json\n[{"a":1}]\n```\nsuffix');
  assert.deepEqual(parsed, [{ a: 1 }]);
});

test("extractJsonFromText parses bare object", () => {
  const parsed = extractJsonFromText('answer {"ok":true} done');
  assert.deepEqual(parsed, { ok: true });
});