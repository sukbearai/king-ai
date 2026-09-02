import assert from "node:assert/strict";
import { test } from "node:test";
import * as telegramModule from "../src/trade/telegram.js";
import { chunkTelegramMessage, deliverTelegramChunks, MAX_TELEGRAM_CHUNKS } from "../src/trade/telegram.js";

type SingleSender = (
  text: string,
  config: Record<string, unknown>,
  options?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<{ outcome: "sent" | "failed" | "unknown"; errorCategory?: string }>;

function singleSender(): SingleSender {
  const sender = (telegramModule as unknown as { sendTelegramSingle?: SingleSender }).sendTelegramSingle;
  assert.equal(typeof sender, "function");
  return sender!;
}

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

test("sendTelegramSingle performs one bounded request and classifies the response", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: string }> = [];
  try {
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body) });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const result = await singleSender()(
      "hello",
      { telegram: { bot_token: "bot-secret", push_chat_id: "chat-1" } },
      { timeoutMs: 1_000 },
    );
    assert.deepEqual(result, { outcome: "sent" });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /sendMessage$/);
    assert.equal(calls[0]!.body, "chat_id=chat-1&text=hello");

    globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
    assert.deepEqual(await singleSender()("hello", { telegram: { bot_token: "bot-secret", push_chat_id: "chat-1" } }), {
      outcome: "failed",
      errorCategory: "telegram_http_429",
    });

    globalThis.fetch = (async () => {
      throw new Error("socket closed");
    }) as typeof fetch;
    assert.deepEqual(await singleSender()("hello", { telegram: { bot_token: "bot-secret", push_chat_id: "chat-1" } }), {
      outcome: "unknown",
      errorCategory: "telegram_transport_unknown",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendTelegramSingle fails before fetch for missing credentials or oversized text", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    assert.deepEqual(await singleSender()("hello", {}), {
      outcome: "failed",
      errorCategory: "telegram_credentials_missing",
    });
    assert.deepEqual(
      await singleSender()("x".repeat(4_001), {
        telegram: { bot_token: "bot-secret", push_chat_id: "chat-1" },
      }),
      { outcome: "failed", errorCategory: "telegram_message_oversized" },
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
