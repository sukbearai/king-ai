import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  HOST_LOOP_RESULTS_HEADER,
  appendHostLoopEvent,
  buildLoopResultsRows,
  readHostLoopEvents,
  readHostLoopResults,
} from "../src/host-loop-events.js";

test("buildLoopResultsRows summarizes classified loops into TSV-ready rows", () => {
  const rows = buildLoopResultsRows([
    { type: "task.created", runId: "run-1", loop: 1, taskId: "t1" },
    { type: "task.transition", runId: "run-1", loop: 1, taskId: "t1", from: "pending", to: "done" },
    { type: "artifact.created", runId: "run-1", loop: 1, kind: "patch" },
    { type: "queue.backlog", runId: "run-1", loop: 1, pendingMessages: 3 },
    {
      type: "loop.classified",
      runId: "run-1",
      loop: 1,
      classification: "productive",
      timestamp: "2026-06-02T00:00:00.000Z",
      completionRate: 0.5,
      reasons: ["task done"],
    },
  ]);

  assert.deepEqual(rows, [
    {
      runId: "run-1",
      loop: 1,
      timestamp: "2026-06-02T00:00:00.000Z",
      classification: "productive",
      tasksCreated: 1,
      tasksDone: 1,
      artifactsCreated: 1,
      pendingMessages: 3,
      completionRate: "0.5",
      notes: "task done",
    },
  ]);
});

test("readHostLoopEvents refreshes results.tsv from the complete event stream", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-host-loop-events-"));
  const file = join(dir, "loop-events.ndjson");
  const resultsFile = join(dir, "results.tsv");
  await writeFile(
    file,
    [
      JSON.stringify({
        type: "loop.classified",
        runId: "run-1",
        loop: 1,
        classification: "idle",
        timestamp: "2026-06-02T00:00:00.000Z",
      }),
      JSON.stringify({ type: "task.transition", runId: "run-1", loop: 2, taskId: "t1", from: "pending", to: "done" }),
      JSON.stringify({
        type: "loop.classified",
        runId: "run-1",
        loop: 2,
        classification: "productive",
        timestamp: "2026-06-02T00:00:01.000Z",
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const result = await readHostLoopEvents({ file, classification: "productive" });

  assert.equal(result.filteredEvents, 1);
  assert.equal(result.results.written, true);
  assert.equal(result.results.rows.length, 2);
  const table = await readFile(resultsFile, "utf8");
  assert.match(table, /^run_id\tloop\ttimestamp\tclassification\t/);
  assert.match(table, /run-1\t1\t2026-06-02T00:00:00\.000Z\tidle\t0\t0\t0\t0\t\t\n/);
  assert.match(table, /run-1\t2\t2026-06-02T00:00:01\.000Z\tproductive\t0\t1\t0\t0\t\t\n/);
});

test("appendHostLoopEvent appends readable NDJSON events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-host-loop-append-"));

  const file = await appendHostLoopEvent({
    outputDir: dir,
    event: {
      type: "run.status",
      runId: "run-1",
      loop: 0,
      status: "running",
      timestamp: "2026-06-02T00:00:04.000Z",
      detail: undefined,
    },
  });

  assert.equal(file, join(dir, "loop-events.ndjson"));
  const raw = await readFile(file, "utf8");
  assert.match(raw, /"type":"run\.status"/);
  assert.equal(raw.includes("detail"), false);
  const result = await readHostLoopEvents({ outputDir: dir, type: "run.status", writeResults: false });
  assert.equal(result.filteredEvents, 1);
  assert.equal(result.events[0]?.status, "running");
});

test("readHostLoopResults reads existing TSV or derives rows from loop events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-host-loop-results-"));
  const resultsFile = join(dir, "results.tsv");
  await writeFile(
    resultsFile,
    `${HOST_LOOP_RESULTS_HEADER}run-2\t3\t2026-06-02T00:00:02.000Z\tblocked\t0\t0\t0\t4\t\twaiting\n`,
    "utf8",
  );

  const existing = await readHostLoopResults({ outputDir: dir });
  assert.equal(existing.rows.length, 1);
  assert.equal(existing.rows[0]?.runId, "run-2");
  assert.equal(existing.rows[0]?.pendingMessages, 4);

  const fallbackDir = await mkdtemp(join(tmpdir(), "king-ai-host-loop-results-fallback-"));
  await writeFile(
    join(fallbackDir, "loop-events.ndjson"),
    [
      JSON.stringify({ type: "artifact.created", runId: "run-3", loop: 1 }),
      JSON.stringify({
        type: "loop.classified",
        runId: "run-3",
        loop: 1,
        classification: "productive",
        timestamp: "2026-06-02T00:00:03.000Z",
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const fallback = await readHostLoopResults({ outputDir: fallbackDir });
  assert.equal(fallback.rows.length, 1);
  assert.equal(fallback.rows[0]?.artifactsCreated, 1);
  assert.match(fallback.text ?? "", /run-3\t1\t2026-06-02T00:00:03\.000Z\tproductive/);
});
