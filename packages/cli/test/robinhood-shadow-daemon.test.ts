import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  dueRobinhoodShadowStages,
  runRobinhoodShadowCycle,
  runRobinhoodShadowDaemon,
} from "../src/trade/robinhood-shadow-daemon.js";

function enabledConfig() {
  return {
    data_sources: {
      robinhood_chain: {
        enabled: true,
        collect_seconds: 30,
        phase1: {
          enabled: true,
          delivery: "shadow",
          discovery_seconds: 60,
          phase2: { enabled: true, delivery: "shadow", collect_seconds: 300 },
        },
      },
    },
  };
}

test("shadow cycle runs Phase 0, Phase 1, then Phase 2", async () => {
  const order: string[] = [];
  const result = await runRobinhoodShadowCycle({
    config: enabledConfig(),
    phase0DbPath: "/tmp/phase0.sqlite",
    phase1DbPath: "/tmp/phase1.sqlite",
    phase2DbPath: "/tmp/phase2.sqlite",
    collectors: {
      phase0: async () => {
        order.push("phase0");
        return { status: "idle" };
      },
      phase1: async () => {
        order.push("phase1");
        return { status: "idle", delivery: "shadow" };
      },
      phase2: async () => {
        order.push("phase2");
        return { status: "persisted", delivery: "shadow", draftsMaterialized: 0, draftsStaled: 0 };
      },
    },
  });
  assert.deepEqual(order, ["phase0", "phase1", "phase2"]);
  assert.equal(result.phase0.status, "ok");
  assert.equal(result.phase1.status, "ok");
  assert.equal(result.phase2.status, "ok");
});

test("shadow cycle records an upstream failure and still runs Phase 2", async () => {
  const order: string[] = [];
  const lines: string[] = [];
  const result = await runRobinhoodShadowCycle({
    config: enabledConfig(),
    phase0DbPath: "/tmp/phase0.sqlite",
    phase1DbPath: "/tmp/phase1.sqlite",
    phase2DbPath: "/tmp/phase2.sqlite",
    onStatus: (line) => lines.push(line),
    collectors: {
      phase0: async () => {
        order.push("phase0");
        throw new Error(`rpc unavailable ${"x".repeat(1000)}`);
      },
      phase1: async () => {
        order.push("phase1");
        throw new Error("phase1 unavailable");
      },
      phase2: async () => {
        order.push("phase2");
        return { status: "source_unhealthy", delivery: "shadow", draftsMaterialized: 0, draftsStaled: 0 };
      },
    },
  });
  assert.deepEqual(order, ["phase0", "phase1", "phase2"]);
  assert.equal(result.phase0.status, "failed");
  assert.equal(result.phase0.error?.length, 500);
  assert.equal(result.phase1.status, "failed");
  assert.equal(result.phase2.status, "ok");
  assert.match(lines.at(-1) ?? "", /phase2 source_unhealthy/);
});

test("shadow schedule keeps Phase 2 on its 300-second cadence", () => {
  const intervals = { phase0: 30, phase1: 60, phase2: 300 };
  const state = { lastPhase0: 0, lastPhase1: 0, lastPhase2: 0 };
  assert.deepEqual(dueRobinhoodShadowStages(30, state, intervals), {
    phase0: true,
    phase1: false,
    phase2: false,
  });
  assert.deepEqual(dueRobinhoodShadowStages(60, state, intervals), {
    phase0: true,
    phase1: true,
    phase2: false,
  });
  assert.deepEqual(dueRobinhoodShadowStages(300, state, intervals), {
    phase0: true,
    phase1: true,
    phase2: true,
  });
});

test("shadow daemon fails closed when any phase is disabled", async () => {
  await assert.rejects(
    () => runRobinhoodShadowDaemon({ config: {}, runOnce: true }),
    /requires Phase 0, Phase 1, and Phase 2 to be enabled/,
  );
});

test("one-shot shadow daemon releases its dedicated pid lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-robinhood-shadow-"));
  const pidPath = join(dir, "shadow.pid");
  try {
    await runRobinhoodShadowDaemon({
      config: enabledConfig(),
      runOnce: true,
      pidPath,
      phase0DbPath: join(dir, "phase0.sqlite"),
      phase1DbPath: join(dir, "phase1.sqlite"),
      phase2DbPath: join(dir, "phase2.sqlite"),
      onStatus: () => undefined,
      collectors: {
        phase0: async () => ({ status: "idle" }),
        phase1: async () => ({ status: "idle", delivery: "shadow" }),
        phase2: async () => ({
          status: "persisted",
          delivery: "shadow",
          draftsMaterialized: 0,
          draftsStaled: 0,
        }),
      },
    });
    await assert.rejects(() => access(pidPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
