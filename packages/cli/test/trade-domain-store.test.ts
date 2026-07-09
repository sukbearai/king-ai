import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createAlert, formatAlert } from "../src/trade/alert-rule.js";
import { dailyPushCapFor, getRuleMeta } from "../src/trade/domain.js";
import { createTradeStore } from "../src/trade/store.js";
import { RuleStateStore } from "../src/trade/rule-state.js";
import { Scratchpad } from "../src/trade/scratchpad.js";
import { acquireDaemonPidLock } from "../src/trade/pid-lock.js";

describe("RuleMeta daily caps", () => {
  it("uses canonical rule ids not display names", () => {
    assert.equal(dailyPushCapFor("treasury"), 4);
    assert.equal(dailyPushCapFor("meme_large"), 8);
    assert.equal(dailyPushCapFor("celebrity"), 5);
    assert.equal(getRuleMeta("b")?.id, "treasury");
  });
});

describe("createAlert fills display name from ruleId", () => {
  it("sets rule display from meta", () => {
    const a = createAlert({
      ruleId: "treasury",
      severity: "warning",
      title: "TLT",
      detail: "drop",
    });
    assert.equal(a.ruleId, "treasury");
    assert.equal(a.rule, "美债抛售");
    assert.match(formatAlert(a), /美债抛售/);
  });
});

describe("TradeStore daily push by ruleId", () => {
  it("counts by canonical ruleId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-store-"));
    const path = join(dir, "rule_state.json");
    const store = createTradeStore({
      ruleState: new RuleStateStore(path),
      scratchpad: new Scratchpad(join(dir, "scratch.json")),
      alertLogPath: join(dir, "alerts.jsonl"),
    });
    assert.equal(await store.getDailyPushCount("treasury"), 0);
    await store.bumpDailyPush("treasury");
    assert.equal(await store.getDailyPushCount("treasury"), 1);
    assert.equal(await store.getDailyPushCount("美债抛售"), 0);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("pid lock", () => {
  it("acquires and releases lock; rejects another live process", async () => {
    const { spawn } = await import("node:child_process");
    const dir = await mkdtemp(join(tmpdir(), "king-ai-pid-"));
    const path = join(dir, "daemon.pid");

    // Placeholder process so process.kill(pid, 0) succeeds for a non-self pid.
    const holder = spawn("sleep", ["30"], { stdio: "ignore" });
    await writeFile(path, `${holder.pid}\n`, "utf8");

    await assert.rejects(() => acquireDaemonPidLock(path), /already running/);

    holder.kill("SIGTERM");
    await new Promise<void>((resolve) => holder.once("exit", () => resolve()));

    const lock = await acquireDaemonPidLock(path);
    assert.equal(Number.parseInt(await readFile(path, "utf8"), 10), process.pid);
    // Same process may refresh its own lock file.
    const again = await acquireDaemonPidLock(path);
    await again.release();
    await lock.release();
    await rm(dir, { recursive: true, force: true });
  });

  it("replaces stale pid file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-pid-stale-"));
    const path = join(dir, "daemon.pid");
    await writeFile(path, "999999991\n", "utf8");
    const lock = await acquireDaemonPidLock(path);
    assert.equal(Number.parseInt(await readFile(path, "utf8"), 10), process.pid);
    await lock.release();
    await rm(dir, { recursive: true, force: true });
  });
});
