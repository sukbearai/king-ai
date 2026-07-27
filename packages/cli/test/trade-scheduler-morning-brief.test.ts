import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

let testDir = "";
const originalConfigDir = process.env.KING_AI_CONFIG_DIR;

before(async () => {
  testDir = await mkdtemp(join(tmpdir(), "king-ai-sched-brief-"));
  process.env.KING_AI_CONFIG_DIR = testDir;
});

after(async () => {
  if (originalConfigDir == null) delete process.env.KING_AI_CONFIG_DIR;
  else process.env.KING_AI_CONFIG_DIR = originalConfigDir;
  await rm(testDir, { recursive: true, force: true });
});

async function loadScheduler() {
  return import("../src/trade/scheduler.js");
}

describe("shouldRunMorningBrief catch-up semantics", () => {
  it("does not run before briefHour on a fresh day", async () => {
    const { shouldRunMorningBrief } = await loadScheduler();
    // Local 04:59, never ran
    const now = new Date(2026, 6, 27, 4, 59, 0);
    assert.equal(shouldRunMorningBrief(now, null, 5), false);
  });

  it("runs at briefHour when not yet claimed today", async () => {
    const { shouldRunMorningBrief } = await loadScheduler();
    const now = new Date(2026, 6, 27, 5, 0, 0);
    assert.equal(shouldRunMorningBrief(now, null, 5), true);
    assert.equal(shouldRunMorningBrief(now, "2026-07-26", 5), true);
  });

  it("does not re-run after today's claim even late in the day", async () => {
    const { shouldRunMorningBrief } = await loadScheduler();
    const now = new Date(2026, 6, 27, 23, 59, 0);
    assert.equal(shouldRunMorningBrief(now, "2026-07-27", 5), false);
  });

  it("runs again the next calendar day after briefHour", async () => {
    const { shouldRunMorningBrief } = await loadScheduler();
    const nextMorning = new Date(2026, 6, 28, 5, 30, 0);
    assert.equal(shouldRunMorningBrief(nextMorning, "2026-07-27", 5), true);
    const nextEarly = new Date(2026, 6, 28, 4, 0, 0);
    assert.equal(shouldRunMorningBrief(nextEarly, "2026-07-27", 5), false);
  });

  it("treats missing lastRun as never ran", async () => {
    const { shouldRunMorningBrief } = await loadScheduler();
    const now = new Date(2026, 6, 27, 12, 0, 0);
    assert.equal(shouldRunMorningBrief(now, null, 5), true);
  });
});

describe("scheduler_state.json morning_brief last-run", () => {
  it("reads null for missing or corrupt files", async () => {
    const { readMorningBriefLastRun } = await loadScheduler();
    const missing = join(testDir, "no-such-scheduler_state.json");
    assert.equal(await readMorningBriefLastRun(missing), null);

    const corrupt = join(testDir, "corrupt_scheduler_state.json");
    await writeFile(corrupt, "{not json", "utf8");
    assert.equal(await readMorningBriefLastRun(corrupt), null);

    const emptyObj = join(testDir, "empty_scheduler_state.json");
    await writeFile(emptyObj, "{}\n", "utf8");
    assert.equal(await readMorningBriefLastRun(emptyObj), null);
  });

  it("claims today's date and reloads it", async () => {
    const { claimMorningBriefRun, readMorningBriefLastRun } = await loadScheduler();
    const path = join(testDir, "scheduler_state.json");
    await claimMorningBriefRun("2026-07-27", path);
    assert.equal(await readMorningBriefLastRun(path), "2026-07-27");
    const raw = JSON.parse(await readFile(path, "utf8")) as { morning_brief_last_run: string };
    assert.equal(raw.morning_brief_last_run, "2026-07-27");
  });

  it("preserves other keys when claiming", async () => {
    const { claimMorningBriefRun, readMorningBriefLastRun } = await loadScheduler();
    const path = join(testDir, "scheduler_state_merge.json");
    await writeFile(path, JSON.stringify({ other: 1, morning_brief_last_run: "2026-07-26" }), "utf8");
    await claimMorningBriefRun("2026-07-27", path);
    assert.equal(await readMorningBriefLastRun(path), "2026-07-27");
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.equal(raw.other, 1);
  });
});
