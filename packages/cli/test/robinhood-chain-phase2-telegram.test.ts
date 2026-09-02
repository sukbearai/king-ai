import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import * as phase2Module from "../src/trade/robinhood-chain-phase2.js";
import { GMGN_FIELD_RUN_REVISION } from "../src/trade/robinhood-chain-gmgn.js";

type SendOutcome = "sent" | "failed" | "unknown";

interface TelegramDeliveryApi {
  initializeRobinhoodPhase2TelegramDelivery(options: {
    config: Record<string, unknown>;
    phase2DbPath: string;
    now: number;
  }): { initialized: boolean; suppressedExisting: number };
  deliverRobinhoodPhase2Telegram(options: {
    config: Record<string, unknown>;
    phase2DbPath: string;
    now: number;
    signal?: AbortSignal;
    send?: (message: string, config: Record<string, unknown>, signal?: AbortSignal) => Promise<SendOutcome>;
    afterSend?: () => void;
  }): Promise<{
    status: string;
    sent: number;
    retryWait: number;
    unknown: number;
    suppressedCooldown: number;
    oversized: number;
  }>;
}

function deliveryApi(): TelegramDeliveryApi {
  const api = phase2Module as unknown as Partial<TelegramDeliveryApi>;
  assert.equal(typeof api.initializeRobinhoodPhase2TelegramDelivery, "function");
  assert.equal(typeof api.deliverRobinhoodPhase2Telegram, "function");
  return api as TelegramDeliveryApi;
}

function config(delivery: "shadow" | "telegram" = "telegram", cooldownSeconds = 3_600) {
  return {
    data_sources: {
      robinhood_chain: {
        enabled: true,
        phase1: {
          enabled: true,
          discovery_source: "gmgn",
          phase2: {
            enabled: true,
            delivery,
            telegram_subject_cooldown_seconds: cooldownSeconds,
          },
        },
      },
    },
  };
}

function address(index: number): string {
  return `0x${index.toString(16).padStart(40, "0")}`;
}

function snapshot(now: number, subjects: number[]) {
  return {
    status: "ok" as const,
    sourceKind: "gmgn" as const,
    lastSuccessAt: now,
    auditedWindows: subjects.length,
    candidates: subjects.map((index) => ({
      pool_key: address(index + 1_000),
      subject_type: "token" as const,
      subject_address: address(index),
      pool_address: address(index + 1_000),
      source_kind: "gmgn" as const,
      window_start: now - 300,
      score: 80,
      components_json: "{}",
      evidence_json: JSON.stringify({ volume5mUsd: 50_000, holderCount: 200 }),
      protocol_id: "gmgn",
      token0: address(index),
      token1: address(999),
      source_first_block: 0,
      source_last_block: 0,
      decoder_version: "gmgn-v1",
      config_revision: GMGN_FIELD_RUN_REVISION,
    })),
    xPosts: new Map(),
  };
}

function deliveryRows(path: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path);
  try {
    return db
      .prepare(
        "SELECT alert_id,subject_key,state,attempts,next_attempt_at,sent_at,last_error_category FROM telegram_deliveries ORDER BY created_at,alert_id",
      )
      .all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

describe("Robinhood Phase 2 automatic Telegram delivery", () => {
  it("keeps shadow mode non-delivering", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-tg-shadow-"));
    const dbPath = join(dir, "phase2.sqlite");
    const store = new phase2Module.RobinhoodPhase2Store(dbPath);
    try {
      const cfg = phase2Module.resolveRobinhoodPhase2Config(config("shadow"));
      store.materialize({ now: 1_700_000_000, cfg, snapshot: snapshot(1_700_000_000, [1]) });
      let calls = 0;
      const result = await deliveryApi().deliverRobinhoodPhase2Telegram({
        config: config("shadow"),
        phase2DbPath: dbPath,
        now: 1_700_000_001,
        send: async () => {
          calls += 1;
          return "sent";
        },
      });
      assert.equal(result.status, "disabled");
      assert.equal(calls, 0);
      assert.equal(deliveryRows(dbPath).length, 0);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("baselines existing drafts and suppresses the same subject during cooldown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-tg-baseline-"));
    const dbPath = join(dir, "phase2.sqlite");
    const cfg = phase2Module.resolveRobinhoodPhase2Config(config());
    const store = new phase2Module.RobinhoodPhase2Store(dbPath);
    try {
      store.materialize({ now: 1_700_000_000, cfg, snapshot: snapshot(1_700_000_000, [1, 2]) });
      const initialized = deliveryApi().initializeRobinhoodPhase2TelegramDelivery({
        config: config(),
        phase2DbPath: dbPath,
        now: 1_700_000_001,
      });
      assert.deepEqual(initialized, { initialized: true, suppressedExisting: 2 });
      assert.deepEqual(
        deliveryRows(dbPath).map((row) => row.state),
        ["suppressed_existing", "suppressed_existing"],
      );

      store.materialize({ now: 1_700_000_300, cfg, snapshot: snapshot(1_700_000_300, [1]) });
      let calls = 0;
      const result = await deliveryApi().deliverRobinhoodPhase2Telegram({
        config: config(),
        phase2DbPath: dbPath,
        now: 1_700_000_301,
        send: async () => {
          calls += 1;
          return "sent";
        },
      });
      assert.equal(result.suppressedCooldown, 1);
      assert.equal(calls, 0);
      assert.equal(deliveryRows(dbPath).at(-1)?.state, "suppressed_cooldown");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("delivers a new subject before readiness and persists sent state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-tg-send-"));
    const dbPath = join(dir, "phase2.sqlite");
    const cfg = phase2Module.resolveRobinhoodPhase2Config(config());
    const store = new phase2Module.RobinhoodPhase2Store(dbPath);
    try {
      deliveryApi().initializeRobinhoodPhase2TelegramDelivery({ config: config(), phase2DbPath: dbPath, now: 10 });
      const materialized = store.materialize({ now: 20, cfg, snapshot: snapshot(20, [3]) });
      assert.equal(materialized.readiness.state, "collecting");
      assert.equal(materialized.readiness.liveDeliveryAuthorized, true);
      const messages: string[] = [];
      const result = await deliveryApi().deliverRobinhoodPhase2Telegram({
        config: config(),
        phase2DbPath: dbPath,
        now: 21,
        send: async (message) => {
          messages.push(message);
          return "sent";
        },
      });
      assert.equal(result.sent, 1);
      assert.equal(messages.length, 1);
      assert.match(messages[0]!, /source=gmgn/);
      assert.equal(deliveryRows(dbPath)[0]?.state, "sent");
      assert.equal(deliveryRows(dbPath)[0]?.attempts, 1);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retries known failure only after backoff and never retries unknown outcome", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-tg-retry-"));
    const dbPath = join(dir, "phase2.sqlite");
    const cfg = phase2Module.resolveRobinhoodPhase2Config(config());
    const store = new phase2Module.RobinhoodPhase2Store(dbPath);
    try {
      deliveryApi().initializeRobinhoodPhase2TelegramDelivery({ config: config(), phase2DbPath: dbPath, now: 10 });
      store.materialize({ now: 20, cfg, snapshot: snapshot(20, [4]) });
      let calls = 0;
      const failed = await deliveryApi().deliverRobinhoodPhase2Telegram({
        config: config(),
        phase2DbPath: dbPath,
        now: 21,
        send: async () => {
          calls += 1;
          return "failed";
        },
      });
      assert.equal(failed.retryWait, 1);
      assert.equal(deliveryRows(dbPath)[0]?.state, "retry_wait");
      await deliveryApi().deliverRobinhoodPhase2Telegram({
        config: config(),
        phase2DbPath: dbPath,
        now: 80,
        send: async () => {
          calls += 1;
          return "sent";
        },
      });
      assert.equal(calls, 1);
      const sent = await deliveryApi().deliverRobinhoodPhase2Telegram({
        config: config(),
        phase2DbPath: dbPath,
        now: 81,
        send: async () => {
          calls += 1;
          return "sent";
        },
      });
      assert.equal(sent.sent, 1);
      assert.equal(calls, 2);
      assert.equal(deliveryRows(dbPath)[0]?.attempts, 2);

      store.materialize({ now: 4_000, cfg, snapshot: snapshot(4_000, [5]) });
      const unknown = await deliveryApi().deliverRobinhoodPhase2Telegram({
        config: config(),
        phase2DbPath: dbPath,
        now: 4_001,
        send: async () => "unknown",
      });
      assert.equal(unknown.unknown, 1);
      let unknownRetryCalls = 0;
      await deliveryApi().deliverRobinhoodPhase2Telegram({
        config: config(),
        phase2DbPath: dbPath,
        now: 8_000,
        send: async () => {
          unknownRetryCalls += 1;
          return "sent";
        },
      });
      assert.equal(unknownRetryCalls, 0);
      assert.equal(deliveryRows(dbPath).at(-1)?.state, "unknown");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("turns an interrupted post-send persistence gap into unknown on restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-tg-ambiguous-"));
    const dbPath = join(dir, "phase2.sqlite");
    const cfg = phase2Module.resolveRobinhoodPhase2Config(config());
    const store = new phase2Module.RobinhoodPhase2Store(dbPath);
    try {
      deliveryApi().initializeRobinhoodPhase2TelegramDelivery({ config: config(), phase2DbPath: dbPath, now: 10 });
      store.materialize({ now: 20, cfg, snapshot: snapshot(20, [6]) });
      await assert.rejects(
        () =>
          deliveryApi().deliverRobinhoodPhase2Telegram({
            config: config(),
            phase2DbPath: dbPath,
            now: 21,
            send: async () => "sent",
            afterSend: () => {
              throw new Error("simulated post-send crash");
            },
          }),
        /post-send crash/,
      );
      assert.equal(deliveryRows(dbPath)[0]?.state, "sending");
      let calls = 0;
      const restarted = await deliveryApi().deliverRobinhoodPhase2Telegram({
        config: config(),
        phase2DbPath: dbPath,
        now: 30,
        send: async () => {
          calls += 1;
          return "sent";
        },
      });
      assert.equal(restarted.unknown, 1);
      assert.equal(calls, 0);
      assert.equal(deliveryRows(dbPath)[0]?.state, "unknown");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("classifies an aborted active send as unknown and starts no later alert", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-tg-abort-"));
    const dbPath = join(dir, "phase2.sqlite");
    const cfg = phase2Module.resolveRobinhoodPhase2Config(config());
    const store = new phase2Module.RobinhoodPhase2Store(dbPath);
    const controller = new AbortController();
    try {
      deliveryApi().initializeRobinhoodPhase2TelegramDelivery({ config: config(), phase2DbPath: dbPath, now: 10 });
      store.materialize({ now: 20, cfg, snapshot: snapshot(20, [7, 8]) });
      let calls = 0;
      const result = await deliveryApi().deliverRobinhoodPhase2Telegram({
        config: config(),
        phase2DbPath: dbPath,
        now: 21,
        signal: controller.signal,
        send: async () => {
          calls += 1;
          controller.abort();
          return "unknown";
        },
      });
      assert.equal(result.unknown, 1);
      assert.equal(calls, 1);
      assert.deepEqual(
        deliveryRows(dbPath).map((row) => row.state),
        ["unknown"],
      );
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps missing Telegram credentials inside retryable delivery state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-tg-credentials-"));
    const dbPath = join(dir, "phase2.sqlite");
    const cfg = phase2Module.resolveRobinhoodPhase2Config(config());
    const store = new phase2Module.RobinhoodPhase2Store(dbPath);
    try {
      deliveryApi().initializeRobinhoodPhase2TelegramDelivery({ config: config(), phase2DbPath: dbPath, now: 10 });
      store.materialize({ now: 20, cfg, snapshot: snapshot(20, [9]) });
      const result = await deliveryApi().deliverRobinhoodPhase2Telegram({
        config: config(),
        phase2DbPath: dbPath,
        now: 21,
      });
      assert.equal(result.retryWait, 1);
      assert.equal(deliveryRows(dbPath)[0]?.state, "retry_wait");
      assert.equal(deliveryRows(dbPath)[0]?.last_error_category, "telegram_credentials_missing");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sends at most ten distinct alerts per cycle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-tg-limit-"));
    const dbPath = join(dir, "phase2.sqlite");
    const cfg = phase2Module.resolveRobinhoodPhase2Config(config());
    const store = new phase2Module.RobinhoodPhase2Store(dbPath);
    try {
      deliveryApi().initializeRobinhoodPhase2TelegramDelivery({ config: config(), phase2DbPath: dbPath, now: 10 });
      store.materialize({
        now: 20,
        cfg,
        snapshot: snapshot(
          20,
          Array.from({ length: 12 }, (_, index) => index + 20),
        ),
      });
      let calls = 0;
      const first = await deliveryApi().deliverRobinhoodPhase2Telegram({
        config: config(),
        phase2DbPath: dbPath,
        now: 21,
        send: async () => {
          calls += 1;
          return "sent";
        },
      });
      assert.equal(first.sent, 10);
      assert.equal(calls, 10);
      const second = await deliveryApi().deliverRobinhoodPhase2Telegram({
        config: config(),
        phase2DbPath: dbPath,
        now: 22,
        send: async () => {
          calls += 1;
          return "sent";
        },
      });
      assert.equal(second.sent, 2);
      assert.equal(calls, 12);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never delivers stale, legacy, or oversized rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-tg-filter-"));
    const dbPath = join(dir, "phase2.sqlite");
    const store = new phase2Module.RobinhoodPhase2Store(dbPath);
    try {
      deliveryApi().initializeRobinhoodPhase2TelegramDelivery({ config: config(), phase2DbPath: dbPath, now: 10 });
      const db = new DatabaseSync(dbPath);
      const insert = db.prepare(`
        INSERT INTO shadow_alerts (
          alert_id,pool_key,window_start,protocol_id,token0,token1,score,strength,state,message,evidence_json,
          first_materialized_at,last_materialized_at,field_run_revision,subject_type,subject_address,pool_address,
          source_kind
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      insert.run(
        "v13",
        address(100),
        1,
        "gmgn",
        address(100),
        address(999),
        80,
        "strong",
        "draft",
        "v13",
        "{}",
        20,
        20,
        "phase2-v13-gmgn-primary",
        "token",
        address(100),
        null,
        "gmgn",
      );
      insert.run(
        "stale",
        address(101),
        1,
        "gmgn",
        address(101),
        address(999),
        80,
        "strong",
        "stale",
        "stale",
        "{}",
        20,
        20,
        GMGN_FIELD_RUN_REVISION,
        "token",
        address(101),
        null,
        "gmgn",
      );
      insert.run(
        "oversized",
        address(102),
        1,
        "gmgn",
        address(102),
        address(999),
        80,
        "strong",
        "draft",
        "x".repeat(4_001),
        "{}",
        20,
        20,
        GMGN_FIELD_RUN_REVISION,
        "token",
        address(102),
        null,
        "gmgn",
      );
      db.close();
      let calls = 0;
      const result = await deliveryApi().deliverRobinhoodPhase2Telegram({
        config: config(),
        phase2DbPath: dbPath,
        now: 21,
        send: async () => {
          calls += 1;
          return "sent";
        },
      });
      assert.equal(result.oversized, 1);
      assert.equal(calls, 0);
      assert.deepEqual(
        deliveryRows(dbPath).map((row) => row.state),
        ["oversized"],
      );
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
