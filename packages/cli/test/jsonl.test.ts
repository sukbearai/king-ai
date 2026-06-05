import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendJsonl, compactJsonl, readJsonl } from "../src/jsonl.js";

test("appendJsonl serializes concurrent writes without interleaving lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-jsonl-"));
  const path = join(dir, "log.jsonl");
  const count = 200;
  // Fire all appends concurrently; the per-path lock must serialize them into intact lines.
  await Promise.all(Array.from({ length: count }, (_unused, index) => appendJsonl(path, { index, value: `row-${index}` })));

  const raw = await readFile(path, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  assert.equal(lines.length, count);
  // Every line must be independently parseable (no torn writes), covering every index exactly once.
  const seen = new Set<number>();
  for (const line of lines) {
    const record = JSON.parse(line) as { index: number };
    seen.add(record.index);
  }
  assert.equal(seen.size, count);
});

test("compactJsonl rewrites the log into the reduced snapshot atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-jsonl-compact-"));
  const path = join(dir, "state.jsonl");
  await appendJsonl(path, { id: "a", v: 1 });
  await appendJsonl(path, { id: "b", v: 1 });
  await appendJsonl(path, { id: "a", v: 2 });

  const result = await compactJsonl(path, (records) => {
    const byId = new Map<string, unknown>();
    for (const record of records) byId.set((record as { id: string }).id, record);
    return [...byId.values()];
  });
  assert.equal(result.records, 3);
  assert.equal(result.written, 2);

  const compacted = await readJsonl(path);
  assert.deepEqual(compacted, [{ id: "a", v: 2 }, { id: "b", v: 1 }]);
});

test("readJsonl returns an empty list for a missing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-jsonl-missing-"));
  assert.deepEqual(await readJsonl(join(dir, "nope.jsonl")), []);
});
