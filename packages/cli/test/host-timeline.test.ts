import assert from "node:assert/strict";
import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendHostTimelineEvent, formatHostTimeline, hostTimelinePath, readHostTimeline, summarizeHostCommandJson } from "../src/host-timeline.js";

test("host timeline appends and reads recent command events", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-ai-host-timeline-"));
  const path = join(root, "host-events.ndjson");

  await appendFile(path, "not-json\n", "utf8");
  await appendHostTimelineEvent({
    at: "2026-06-02T00:00:00.000Z",
    type: "host.command",
    command: "status",
    ok: true,
    exitCode: 0,
    destructive: false,
    durationMs: 12,
    textPreview: "host status: ok"
  }, path);
  await appendHostTimelineEvent({
    at: "2026-06-02T00:00:01.000Z",
    type: "host.command",
    command: "export",
    ok: true,
    exitCode: 0,
    destructive: true,
    durationMs: 34
  }, path);

  assert.equal(hostTimelinePath(path), path);
  const events = await readHostTimeline({ path, limit: 1 });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.command, "export");
  assert.match(formatHostTimeline(events), /export ok exit=0 destructive 34ms/);
});

test("host timeline command summaries stay compact", () => {
  const summary = summarizeHostCommandJson("export", {
    runId: "run-1",
    exportDir: "/tmp/out/run-1",
    writtenFiles: ["/tmp/out/run-1/a.txt", "/tmp/out/run-1/b.txt"]
  }) as { writtenFiles?: number };

  assert.equal(summary.writtenFiles, 2);
  assert.deepEqual(summarizeHostCommandJson("unknown", { large: "value" }), undefined);
});
