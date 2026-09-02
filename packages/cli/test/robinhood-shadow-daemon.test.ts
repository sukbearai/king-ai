import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createRobinhoodShadowXRunner,
  dueRobinhoodShadowStages,
  dueRobinhoodShadowX,
  runRobinhoodShadowCycle,
  runRobinhoodShadowDaemon,
} from "../src/trade/robinhood-shadow-daemon.js";

function enabledConfig() {
  return {
    data_sources: {
      robinhood_chain: {
        enabled: true,
        rpc_urls: ["https://shared.example"],
        collect_seconds: 30,
        phase1: {
          enabled: true,
          delivery: "shadow",
          rpc_urls: ["https://shared.example"],
          discovery_seconds: 60,
          provider_cooldown_ms: 0,
          x_enabled: true,
          x_collect_seconds: 300,
          phase2: { enabled: true, delivery: "shadow", collect_seconds: 300 },
        },
      },
    },
  };
}

function gmgnConfig() {
  const config = enabledConfig();
  (config.data_sources.robinhood_chain.phase1 as Record<string, unknown>).discovery_source = "gmgn";
  return config;
}

function telegramGmgnConfig() {
  const config = gmgnConfig();
  config.data_sources.robinhood_chain.phase1.phase2.delivery = "telegram";
  return config;
}

test("GMGN shadow mode skips full-chain RPC discovery and runs GMGN before Phase 2", async () => {
  const order: string[] = [];
  const result = await runRobinhoodShadowCycle({
    config: gmgnConfig(),
    phase0DbPath: "/tmp/phase0.sqlite",
    phase1DbPath: "/tmp/phase1.sqlite",
    phase2DbPath: "/tmp/phase2.sqlite",
    collectors: {
      phase0: async () => {
        order.push("phase0");
        return { status: "idle" };
      },
      phase1: async () => {
        order.push("rpc-phase1");
        return { status: "idle", delivery: "shadow" };
      },
      gmgn: async () => {
        order.push("gmgn");
        return {
          status: "persisted",
          delivery: "shadow",
          observationsPersisted: 1,
          candidatesQualified: 1,
          candidatesVerified: 1,
        };
      },
      phase2: async () => {
        order.push("phase2");
        return { status: "persisted", delivery: "shadow", draftsMaterialized: 1, draftsStaled: 0 };
      },
    },
  } as never);
  assert.deepEqual(order, ["gmgn", "phase2"]);
  assert.equal(result.phase0.status, "skipped");
  assert.equal(result.phase1.status, "ok");
});

test("shadow cycle owns Telegram delivery after Phase 2 persistence", async () => {
  const order: string[] = [];
  const lines: string[] = [];
  await runRobinhoodShadowCycle({
    config: telegramGmgnConfig(),
    phase0DbPath: "/tmp/phase0.sqlite",
    phase1DbPath: "/tmp/phase1.sqlite",
    phase2DbPath: "/tmp/phase2.sqlite",
    onStatus: (line: string) => lines.push(line),
    collectors: {
      gmgn: async () => {
        order.push("gmgn");
        return {
          status: "persisted",
          delivery: "shadow",
          observationsPersisted: 1,
          candidatesQualified: 1,
          candidatesVerified: 1,
        };
      },
      phase2: async () => {
        order.push("phase2");
        return {
          status: "persisted",
          delivery: "telegram",
          draftsMaterialized: 1,
          draftsStaled: 0,
        };
      },
      phase2Telegram: async () => {
        order.push("telegram");
        return {
          status: "completed",
          sent: 1,
          retryWait: 0,
          unknown: 0,
          suppressedCooldown: 0,
          oversized: 0,
        };
      },
    },
  } as never);
  assert.deepEqual(order, ["gmgn", "phase2", "telegram"]);
  assert.ok(lines.some((line) => line.includes("telegram completed sent=1")));
});

test("shadow cycle does not call Telegram delivery in shadow mode or after Phase 2 failure", async () => {
  for (const phase2Fails of [false, true]) {
    let deliveryCalls = 0;
    const config = phase2Fails ? telegramGmgnConfig() : gmgnConfig();
    await runRobinhoodShadowCycle({
      config,
      phase0DbPath: "/tmp/phase0.sqlite",
      phase1DbPath: "/tmp/phase1.sqlite",
      phase2DbPath: "/tmp/phase2.sqlite",
      collectors: {
        gmgn: async () => ({
          status: "persisted",
          delivery: "shadow",
          observationsPersisted: 1,
          candidatesQualified: 1,
          candidatesVerified: 1,
        }),
        phase2: async () => {
          if (phase2Fails) throw new Error("phase2 offline");
          return { status: "persisted", delivery: "shadow", draftsMaterialized: 1, draftsStaled: 0 };
        },
        phase2Telegram: async () => {
          deliveryCalls += 1;
          return {
            status: "completed",
            sent: 1,
            retryWait: 0,
            unknown: 0,
            suppressedCooldown: 0,
            oversized: 0,
          };
        },
      },
    } as never);
    assert.equal(deliveryCalls, 0);
  }
});

test("Telegram delivery failure does not roll back a persisted Phase 2 cycle", async () => {
  const lines: string[] = [];
  const result = await runRobinhoodShadowCycle({
    config: telegramGmgnConfig(),
    phase0DbPath: "/tmp/phase0.sqlite",
    phase1DbPath: "/tmp/phase1.sqlite",
    phase2DbPath: "/tmp/phase2.sqlite",
    onStatus: (line: string) => lines.push(line),
    collectors: {
      gmgn: async () => ({
        status: "persisted",
        delivery: "shadow",
        observationsPersisted: 1,
        candidatesQualified: 1,
        candidatesVerified: 1,
      }),
      phase2: async () => ({
        status: "persisted",
        delivery: "telegram",
        draftsMaterialized: 1,
        draftsStaled: 0,
      }),
      phase2Telegram: async () => {
        throw new Error("Telegram unavailable");
      },
    },
  } as never);
  assert.equal(result.phase2.status, "ok");
  assert.equal(result.phase2.result?.status, "persisted");
  assert.equal(result.telegram.status, "failed");
  assert.ok(lines.some((line) => line.includes("telegram failed: Telegram unavailable")));
});

test("shadow cycle cools down the provider between due Phase 0 and Phase 1 stages", async () => {
  const config = enabledConfig();
  config.data_sources.robinhood_chain.rpc_urls = ["https://user:secret@shared.example/?api_key=hidden"];
  config.data_sources.robinhood_chain.phase1.rpc_urls = ["https://shared.example"];
  config.data_sources.robinhood_chain.phase1.provider_cooldown_ms = 5000;
  const order: string[] = [];
  await runRobinhoodShadowCycle({
    config,
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
    wait: async (ms: number) => {
      order.push(`cooldown:${ms}`);
      return true;
    },
  });
  assert.deepEqual(order, ["phase0", "cooldown:5000", "phase1", "phase2"]);
});

test("shadow cycle runs Phase 0 and Phase 1 concurrently for disjoint RPC sets before Phase 2", async () => {
  const config = enabledConfig();
  config.data_sources.robinhood_chain.phase1.rpc_urls = ["https://phase1.example"];
  config.data_sources.robinhood_chain.phase1.provider_cooldown_ms = 5000;
  const order: string[] = [];
  let releasePhase0: (() => void) | undefined;
  let releasePhase1: (() => void) | undefined;
  let cooldownCalls = 0;
  const cycle = runRobinhoodShadowCycle({
    config,
    phase0DbPath: "/tmp/phase0.sqlite",
    phase1DbPath: "/tmp/phase1.sqlite",
    phase2DbPath: "/tmp/phase2.sqlite",
    collectors: {
      phase0: async () => {
        order.push("phase0:start");
        await new Promise<void>((resolve) => {
          releasePhase0 = resolve;
        });
        order.push("phase0:end");
        return { status: "idle" };
      },
      phase1: async () => {
        order.push("phase1:start");
        await new Promise<void>((resolve) => {
          releasePhase1 = resolve;
        });
        order.push("phase1:end");
        return { status: "idle", delivery: "shadow" };
      },
      phase2: async () => {
        order.push("phase2");
        return { status: "persisted", delivery: "shadow", draftsMaterialized: 0, draftsStaled: 0 };
      },
    },
    wait: async () => {
      cooldownCalls += 1;
      return true;
    },
  });

  await Promise.resolve();
  assert.deepEqual(order, ["phase0:start", "phase1:start"]);
  assert.equal(cooldownCalls, 0);
  releasePhase0?.();
  await Promise.resolve();
  assert.equal(order.includes("phase2"), false);
  releasePhase1?.();
  await cycle;
  assert.equal(order.at(-1), "phase2");
});

test("a failed concurrent Phase 0 does not cancel Phase 1 and Phase 2 waits for both", async () => {
  const config = enabledConfig();
  config.data_sources.robinhood_chain.phase1.rpc_urls = ["https://phase1.example"];
  const order: string[] = [];
  let rejectPhase0: ((error: Error) => void) | undefined;
  let releasePhase1: (() => void) | undefined;
  const cycle = runRobinhoodShadowCycle({
    config,
    phase0DbPath: "/tmp/phase0.sqlite",
    phase1DbPath: "/tmp/phase1.sqlite",
    phase2DbPath: "/tmp/phase2.sqlite",
    collectors: {
      phase0: async () => {
        order.push("phase0:start");
        await new Promise<void>((_resolve, reject) => {
          rejectPhase0 = reject;
        });
        return { status: "idle" };
      },
      phase1: async () => {
        order.push("phase1:start");
        await new Promise<void>((resolve) => {
          releasePhase1 = resolve;
        });
        order.push("phase1:end");
        return { status: "idle", delivery: "shadow" };
      },
      phase2: async () => {
        order.push("phase2");
        return { status: "source_unhealthy", delivery: "shadow", draftsMaterialized: 0, draftsStaled: 0 };
      },
    },
  });

  await Promise.resolve();
  assert.deepEqual(order, ["phase0:start", "phase1:start"]);
  rejectPhase0?.(new Error("phase0 unavailable"));
  releasePhase1?.();
  const result = await cycle;
  assert.deepEqual(order, ["phase0:start", "phase1:start", "phase1:end", "phase2"]);
  assert.equal(result.phase0.status, "failed");
  assert.equal(result.phase1.status, "ok");
  assert.equal(result.phase2.status, "ok");
});

test("an interrupted provider cooldown skips new chain work", async () => {
  const config = enabledConfig();
  config.data_sources.robinhood_chain.phase1.provider_cooldown_ms = 5000;
  const controller = new AbortController();
  const order: string[] = [];
  const result = await runRobinhoodShadowCycle({
    config,
    phase0DbPath: "/tmp/phase0.sqlite",
    phase1DbPath: "/tmp/phase1.sqlite",
    phase2DbPath: "/tmp/phase2.sqlite",
    signal: controller.signal,
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
    wait: async (ms: number, signal?: AbortSignal) => {
      order.push(`cooldown:${ms}`);
      controller.abort();
      return !signal?.aborted;
    },
  });
  assert.deepEqual(order, ["phase0", "cooldown:5000"]);
  assert.equal(result.phase1.status, "skipped");
  assert.equal(result.phase2.status, "skipped");
});

test("daemon shutdown during provider cooldown starts no later chain or X stage", async () => {
  const config = enabledConfig();
  config.data_sources.robinhood_chain.phase1.provider_cooldown_ms = 5000;
  const controller = new AbortController();
  const dir = await mkdtemp(join(tmpdir(), "king-ai-robinhood-shadow-cooldown-stop-"));
  const order: string[] = [];
  let markCooldownStarted: (() => void) | undefined;
  const cooldownStarted = new Promise<void>((resolve) => {
    markCooldownStarted = resolve;
  });
  try {
    const daemon = runRobinhoodShadowDaemon({
      config,
      signal: controller.signal,
      pidPath: join(dir, "shadow.pid"),
      phase0DbPath: join(dir, "phase0.sqlite"),
      phase1DbPath: join(dir, "phase1.sqlite"),
      phase2DbPath: join(dir, "phase2.sqlite"),
      onStatus: () => undefined,
      wait: async (ms, signal) => {
        order.push(`cooldown:${ms}`);
        markCooldownStarted?.();
        if (signal?.aborted) return false;
        return await new Promise<boolean>((resolve) => {
          signal?.addEventListener("abort", () => resolve(false), { once: true });
        });
      },
      collectors: {
        phase0: async () => {
          order.push("phase0");
          return { status: "idle" };
        },
        phase1: async () => {
          order.push("phase1");
          return { status: "idle", delivery: "shadow" };
        },
        phase1X: async () => {
          order.push("phase1X");
          return { status: "persisted", accountsChecked: 0, postsObserved: 0, health: {} };
        },
        phase2: async () => {
          order.push("phase2");
          return { status: "persisted", delivery: "shadow", draftsMaterialized: 0, draftsStaled: 0 };
        },
      },
    });
    await cooldownStarted;
    controller.abort();
    await daemon;
    assert.deepEqual(order, ["phase0", "cooldown:5000"]);
    await assert.rejects(() => access(join(dir, "shadow.pid")));
  } finally {
    controller.abort();
    await rm(dir, { recursive: true, force: true });
  }
});

test("daemon shutdown drains disjoint in-flight chain stages before releasing the lock", async () => {
  const config = enabledConfig();
  config.data_sources.robinhood_chain.phase1.rpc_urls = ["https://phase1.example"];
  const controller = new AbortController();
  const dir = await mkdtemp(join(tmpdir(), "king-ai-robinhood-shadow-parallel-stop-"));
  const pidPath = join(dir, "shadow.pid");
  const order: string[] = [];
  let releasePhase0: (() => void) | undefined;
  let releasePhase1: (() => void) | undefined;
  let markPhase0Started: (() => void) | undefined;
  let markPhase1Started: (() => void) | undefined;
  const phase0Started = new Promise<void>((resolve) => {
    markPhase0Started = resolve;
  });
  const phase1Started = new Promise<void>((resolve) => {
    markPhase1Started = resolve;
  });
  try {
    const daemon = runRobinhoodShadowDaemon({
      config,
      signal: controller.signal,
      pidPath,
      phase0DbPath: join(dir, "phase0.sqlite"),
      phase1DbPath: join(dir, "phase1.sqlite"),
      phase2DbPath: join(dir, "phase2.sqlite"),
      onStatus: () => undefined,
      collectors: {
        phase0: async () => {
          order.push("phase0:start");
          markPhase0Started?.();
          await new Promise<void>((resolve) => {
            releasePhase0 = resolve;
          });
          order.push("phase0:end");
          return { status: "idle" };
        },
        phase1: async () => {
          order.push("phase1:start");
          markPhase1Started?.();
          await new Promise<void>((resolve) => {
            releasePhase1 = resolve;
          });
          order.push("phase1:end");
          return { status: "idle", delivery: "shadow" };
        },
        phase1X: async () => {
          order.push("phase1X");
          return { status: "persisted", accountsChecked: 0, postsObserved: 0, health: {} };
        },
        phase2: async () => {
          order.push("phase2");
          return { status: "persisted", delivery: "shadow", draftsMaterialized: 0, draftsStaled: 0 };
        },
      },
    });
    await Promise.all([phase0Started, phase1Started]);
    controller.abort();
    await access(pidPath);
    releasePhase0?.();
    await Promise.resolve();
    await access(pidPath);
    releasePhase1?.();
    await daemon;
    assert.deepEqual(order, ["phase0:start", "phase1:start", "phase0:end", "phase1:end"]);
    await assert.rejects(() => access(pidPath));
  } finally {
    controller.abort();
    releasePhase0?.();
    releasePhase1?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("shadow cycle runs only Phase 0, Phase 1, then Phase 2", async () => {
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

test("shadow daemon preserves explicit X opt-out", async () => {
  const config = enabledConfig();
  config.data_sources.robinhood_chain.phase1.x_enabled = false;
  let xCalls = 0;
  const dir = await mkdtemp(join(tmpdir(), "king-ai-robinhood-shadow-x-disabled-"));
  try {
    await runRobinhoodShadowDaemon({
      config,
      runOnce: true,
      pidPath: join(dir, "shadow.pid"),
      phase0DbPath: join(dir, "phase0.sqlite"),
      phase1DbPath: join(dir, "phase1.sqlite"),
      phase2DbPath: join(dir, "phase2.sqlite"),
      onStatus: () => undefined,
      collectors: {
        phase0: async () => ({ status: "idle" }),
        phase1: async () => ({ status: "idle", delivery: "shadow" }),
        phase1X: async () => {
          xCalls += 1;
          return { status: "persisted", accountsChecked: 0, postsObserved: 0, health: {} };
        },
        phase2: async () => ({
          status: "persisted",
          delivery: "shadow",
          draftsMaterialized: 0,
          draftsStaled: 0,
        }),
      },
    });
    assert.equal(xCalls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test("shadow schedule keeps chain stages on their own cadence", () => {
  const intervals = { phase0: 30, phase1: 60, phase2: 300 };
  const state = { lastPhase0: 0, lastPhase1: 0, lastPhase1X: 0, lastPhase2: 0 };
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

test("shadow daemon grants realtime rebase only to each collector's first process attempt", async () => {
  const config = enabledConfig();
  config.data_sources.robinhood_chain.phase1.x_enabled = false;
  const controller = new AbortController();
  const dir = await mkdtemp(join(tmpdir(), "king-ai-robinhood-shadow-rebase-owner-"));
  const phase0Permissions: unknown[] = [];
  const phase1Permissions: unknown[] = [];
  let currentTime = 0;
  let phase0Calls = 0;
  let phase1Calls = 0;
  try {
    await runRobinhoodShadowDaemon({
      config,
      signal: controller.signal,
      now: () => {
        currentTime += 30;
        return currentTime;
      },
      pidPath: join(dir, "shadow.pid"),
      phase0DbPath: join(dir, "phase0.sqlite"),
      phase1DbPath: join(dir, "phase1.sqlite"),
      phase2DbPath: join(dir, "phase2.sqlite"),
      onStatus: () => undefined,
      collectors: {
        phase0: async (input) => {
          phase0Calls += 1;
          phase0Permissions.push((input as typeof input & { allowRealtimeRebase?: boolean }).allowRealtimeRebase);
          if (phase0Calls === 1) throw new Error("first Phase 0 attempt failed");
          return { status: "idle" };
        },
        phase1: async (input) => {
          phase1Calls += 1;
          phase1Permissions.push((input as typeof input & { allowRealtimeRebase?: boolean }).allowRealtimeRebase);
          if (phase1Calls === 2) controller.abort();
          return { status: "idle", delivery: "shadow" };
        },
        phase2: async () => ({
          status: "persisted",
          delivery: "shadow",
          draftsMaterialized: 0,
          draftsStaled: 0,
        }),
      },
    });
    assert.deepEqual(phase0Permissions, [true, false]);
    assert.deepEqual(phase1Permissions, [true, false]);
  } finally {
    controller.abort();
    await rm(dir, { recursive: true, force: true });
  }
});

test("shadow X schedule is independent from the chain stages", () => {
  assert.equal(dueRobinhoodShadowX(299, 0, 300), false);
  assert.equal(dueRobinhoodShadowX(300, 0, 300), true);
  assert.equal(dueRobinhoodShadowX(600, 300, 300), true);
});

test("shadow X runner prevents overlap and can restart after completion", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const runner = createRobinhoodShadowXRunner(
    () =>
      new Promise<void>((resolve) => {
        calls += 1;
        release = resolve;
      }),
  );

  assert.equal(runner.start(), true);
  assert.equal(runner.start(), false);
  await Promise.resolve();
  assert.equal(calls, 1);
  release?.();
  await runner.drain();

  assert.equal(runner.start(), true);
  await Promise.resolve();
  assert.equal(calls, 2);
  release?.();
  await runner.drain();
});

test("one-shot daemon completes the chain before X and drains X before releasing the lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-robinhood-shadow-independent-x-"));
  const pidPath = join(dir, "shadow.pid");
  const order: string[] = [];
  let releaseX: (() => void) | undefined;
  let markXStarted: (() => void) | undefined;
  const xStarted = new Promise<void>((resolve) => {
    markXStarted = resolve;
  });
  try {
    const daemon = runRobinhoodShadowDaemon({
      config: enabledConfig(),
      runOnce: true,
      pidPath,
      phase0DbPath: join(dir, "phase0.sqlite"),
      phase1DbPath: join(dir, "phase1.sqlite"),
      phase2DbPath: join(dir, "phase2.sqlite"),
      onStatus: () => undefined,
      collectors: {
        phase0: async () => {
          order.push("phase0");
          return { status: "idle" };
        },
        phase1: async () => {
          order.push("phase1");
          return { status: "idle", delivery: "shadow" };
        },
        phase1X: async () => {
          order.push("phase1X");
          markXStarted?.();
          await new Promise<void>((resolve) => {
            releaseX = resolve;
          });
          return { status: "persisted", accountsChecked: 1, postsObserved: 1, health: { ok: 1 } };
        },
        phase2: async () => {
          order.push("phase2");
          return { status: "persisted", delivery: "shadow", draftsMaterialized: 0, draftsStaled: 0 };
        },
      },
    });

    await xStarted;
    assert.deepEqual(order, ["phase0", "phase1", "phase2", "phase1X"]);
    await access(pidPath);
    const release = releaseX;
    assert.ok(release);
    release();
    await daemon;
    await assert.rejects(() => access(pidPath));
  } finally {
    releaseX?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("X failure is logged without failing the completed chain cycle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-robinhood-shadow-x-failure-"));
  const lines: string[] = [];
  try {
    await runRobinhoodShadowDaemon({
      config: enabledConfig(),
      runOnce: true,
      pidPath: join(dir, "shadow.pid"),
      phase0DbPath: join(dir, "phase0.sqlite"),
      phase1DbPath: join(dir, "phase1.sqlite"),
      phase2DbPath: join(dir, "phase2.sqlite"),
      onStatus: (line) => lines.push(line),
      collectors: {
        phase0: async () => ({ status: "idle" }),
        phase1: async () => ({ status: "idle", delivery: "shadow" }),
        phase1X: async () => {
          throw new Error("browser unavailable");
        },
        phase2: async () => ({
          status: "persisted",
          delivery: "shadow",
          draftsMaterialized: 0,
          draftsStaled: 0,
        }),
      },
    });
    assert.ok(lines.some((line) => line.includes("phase2 persisted")));
    assert.ok(lines.some((line) => line.includes("phase1-x failed: browser unavailable")));
    assert.equal(lines.at(-1), "[robinhood-shadow] stopped");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
        phase1X: async () => ({ status: "persisted", accountsChecked: 0, postsObserved: 0, health: {} }),
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
