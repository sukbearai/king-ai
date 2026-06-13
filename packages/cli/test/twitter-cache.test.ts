import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { engagementScore, entryTimestamp, formatTweetLine, iterCacheRecords } from "../src/trade/twitter-cache.js";

test("iterCacheRecords parses JSONL tweets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "twitter-cache-"));
  const path = join(dir, "cache.jsonl");
  await writeFile(path, [
    '{"id":"1","author":"alice","text":"$BTC pump","likes":10,"views":1000,"created_at":"Wed Jun 11 10:00:00 +0000 2026"}',
    '{"id":"2","author":"bob","text":"hello","likes":1,"created_at":"2026-06-11T11:00:00Z"}'
  ].join("\n"), "utf8");

  const rows = [];
  for await (const entry of iterCacheRecords(path)) rows.push(entry);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.author, "alice");
});

test("formatTweetLine and engagementScore include metrics", () => {
  const line = formatTweetLine({
    id: "9",
    author: "cz",
    text: "test",
    likes: 5,
    views: 200
  });
  assert.match(line, /@cz: test/);
  assert.match(line, /5❤️/);
  assert.ok(engagementScore(line) >= 5);
});

test("entryTimestamp accepts ISO dates", () => {
  const ts = entryTimestamp({ created_at: "2026-06-11T11:00:00Z" });
  assert.ok(ts instanceof Date);
});