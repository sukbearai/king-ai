import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkTelegramMessage } from "../src/trade/telegram.js";

test("chunkTelegramMessage keeps short messages intact", () => {
  const text = "hello world";
  assert.deepEqual(chunkTelegramMessage(text), [text]);
});

test("chunkTelegramMessage splits on paragraph boundaries", () => {
  const para = "x".repeat(2000);
  const text = `${para}\n\n${para}`;
  const chunks = chunkTelegramMessage(text, 2500);
  assert.ok(chunks.length >= 2);
  for (const ch of chunks) {
    assert.ok(ch.length <= 2500);
  }
});
