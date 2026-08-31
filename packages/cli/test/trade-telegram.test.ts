import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkTelegramMessage, deliverTelegramChunks, MAX_TELEGRAM_CHUNKS } from "../src/trade/telegram.js";

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

test("deliverTelegramChunks refuses runaway chunk counts before sending", async () => {
  let calls = 0;
  const sender = async () => {
    calls += 1;
    return true;
  };
  const text = "x".repeat((MAX_TELEGRAM_CHUNKS + 1) * 4000);
  assert.equal(await deliverTelegramChunks(text, sender), false);
  assert.equal(calls, 0);
});

test("deliverTelegramChunks stops after the first failed chunk", async () => {
  const chunks: string[] = [];
  const ok = await deliverTelegramChunks(`first\n\n${"x".repeat(4000)}\n\nlast`, async (chunk) => {
    chunks.push(chunk);
    return false;
  });
  assert.equal(ok, false);
  assert.equal(chunks.length, 1);
});
