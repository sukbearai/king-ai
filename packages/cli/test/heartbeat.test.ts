import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileHeartbeat } from "../src/heartbeat.js";

test("FileHeartbeat writes liveness data and increments loop count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-heartbeat-"));
  const path = join(dir, "nested", "heartbeat.json");
  const heartbeat = new FileHeartbeat(path, {
    pid: 123,
    runId: "run-1",
    version: "1.2.3",
    computerId: "computer-1",
    serverUrl: "https://runtime.example"
  });

  const first = heartbeat.write();
  assert.equal(first.loopCount, 0);
  assert.equal(heartbeat.count, 0);

  const second = heartbeat.tick();
  assert.equal(second.loopCount, 1);
  assert.equal(heartbeat.count, 1);

  const saved = JSON.parse(await readFile(path, "utf8")) as {
    pid: number;
    runId: string;
    loopCount: number;
    version: string;
    computerId: string;
    serverUrl: string;
    lastTick: string;
  };
  assert.deepEqual({
    pid: saved.pid,
    runId: saved.runId,
    loopCount: saved.loopCount,
    version: saved.version,
    computerId: saved.computerId,
    serverUrl: saved.serverUrl
  }, {
    pid: 123,
    runId: "run-1",
    loopCount: 1,
    version: "1.2.3",
    computerId: "computer-1",
    serverUrl: "https://runtime.example"
  });
  assert.match(saved.lastTick, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});
