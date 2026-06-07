import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeGetStrict, runtimePostStrict } from "../src/api.js";

test("runtime strict helpers throw on runtime HTTP failures", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), "https://runtime.example/runtime/inbox");
      assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, "Bearer token");
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;

    await assert.rejects(
      () => runtimeGetStrict("https://runtime.example", "/inbox", "token"),
      /GET \/inbox -> HTTP 503 unavailable/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runtime strict post sends tenant headers and parses JSON", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), "https://runtime.example/runtime/conversation/mark-read");
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer token");
      assert.equal(headers["X-King-AI-Tenant"], "tenant-a");
      assert.equal(init?.body, JSON.stringify({ conversationId: "room", upToMessageId: "msg-1" }));
      return Response.json({ ok: true });
    }) as typeof fetch;

    const result = await runtimePostStrict<{ ok: boolean }>(
      "https://runtime.example",
      "/conversation/mark-read",
      "token",
      { conversationId: "room", upToMessageId: "msg-1" },
      "tenant-a"
    );
    assert.deepEqual(result, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
