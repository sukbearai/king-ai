import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSseStream } from "../src/sse.js";

async function collect(input: string[]): Promise<unknown[]> {
  async function* chunks() {
    for (const s of input) yield Buffer.from(s);
  }
  const out = [];
  for await (const evt of parseSseStream(chunks())) out.push(evt);
  return out;
}

test("parseSseStream parses split SSE blocks", async () => {
  const events = await collect([
    "event: wake\n",
    "data: {\"conversationId\":\"c1\"}\n\n",
    ": keepalive\n\n",
    "id: 2\nevent: steer\ndata: {}\n\n"
  ]);
  assert.deepEqual(events, [
    { event: "wake", data: "{\"conversationId\":\"c1\"}" },
    { id: "2", event: "steer", data: "{}" }
  ]);
});
