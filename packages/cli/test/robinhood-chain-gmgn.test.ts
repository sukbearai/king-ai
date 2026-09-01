import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  GmgnOpenApiClient,
  RobinhoodGmgnStore,
  buildGmgnCandidates,
  collectRobinhoodGmgn,
  normalizeGmgnTrenches,
  normalizeGmgnTrending,
  readGmgnApiKey,
  resolveRobinhoodGmgnConfig,
  verifyGmgnCandidates,
  type GmgnCandidate,
  type GmgnObservation,
} from "../src/trade/robinhood-chain-gmgn.js";
import { runRobinhoodGmgnCollectorJob } from "../src/trade/scheduler.js";

const TOKEN = `0x${"a".repeat(40)}`;
const POOL = `0x${"b".repeat(40)}`;

function config(overrides: Record<string, unknown> = {}) {
  return {
    data_sources: {
      robinhood_chain: {
        enabled: true,
        rpc_urls: ["https://rpc.example"],
        phase1: {
          enabled: true,
          delivery: "shadow",
          discovery_source: "gmgn",
          min_liquidity_usd: 25_000,
          min_volume_5m_usd: 10_000,
          min_trend_score: 50,
          ...overrides,
        },
      },
    },
  };
}

function trendingRow(overrides: Record<string, unknown> = {}) {
  return {
    address: TOKEN.toUpperCase().replace(/^0X/, "0x"),
    symbol: "TEST",
    price: "0.25",
    volume: "50000",
    swaps: "42",
    liquidity: "75000",
    market_cap: "1000000",
    holder_count: "250",
    smart_degen_count: 2,
    renowned_count: 1,
    is_honeypot: false,
    is_wash_trading: 0,
    ...overrides,
  };
}

function observation(segment: GmgnObservation["segment"], overrides: Partial<GmgnObservation> = {}): GmgnObservation {
  const feed = segment === "1m" || segment === "5m" || segment === "1h" ? "trending" : "trenches";
  return {
    observationKey: `gmgn:${feed}:${segment}:${TOKEN}:1699999800`,
    feed,
    segment,
    address: TOKEN,
    poolAddress: segment === "new_creation" ? POOL : null,
    windowStart: 1_699_999_800,
    upstreamObservedAt: 1_700_000_000,
    ingestedAt: 1_699_999_895,
    fresh: true,
    symbol: "TEST",
    price: 0.25,
    volume: 50_000,
    swaps: 42,
    liquidity: 75_000,
    marketCap: 1_000_000,
    holderCount: 250,
    smartDegenCount: 2,
    renownedCount: 1,
    isHoneypot: false,
    isWashTrading: false,
    evidence: {},
    ...overrides,
  };
}

describe("Robinhood GMGN primary collector", () => {
  it("resolves an explicit bounded GMGN mode without changing legacy RPC defaults", () => {
    const resolved = resolveRobinhoodGmgnConfig(
      config({ gmgn_limit: 999, gmgn_max_age_seconds: 9999, gmgn_rpc_verify_limit: 999 }),
    );
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.limit, 200);
    assert.equal(resolved.maxAgeSeconds, 600);
    assert.equal(resolved.rpcVerifyLimit, 20);
    assert.deepEqual(resolved.rpcUrls, ["https://rpc.example"]);
    assert.equal(resolveRobinhoodGmgnConfig(config({ discovery_source: "rpc" })).enabled, false);
  });

  it("reads only the API key and never touches the private-key property", () => {
    const env = Object.defineProperties(
      {},
      {
        GMGN_API_KEY: { enumerable: true, get: () => "api-key" },
        GMGN_PRIVATE_KEY: {
          enumerable: true,
          get: () => {
            throw new Error("private key accessed");
          },
        },
      },
    ) as NodeJS.ProcessEnv;
    assert.equal(readGmgnApiKey(env), "api-key");
    assert.throws(() => readGmgnApiKey({}), /GMGN_API_KEY is required/);
  });

  it("unwraps the nested trending envelope and preserves unknown values", () => {
    const rows = normalizeGmgnTrending(
      {
        code: 0,
        data: { code: 0, data: { rank: [trendingRow(), trendingRow({ address: "invalid", liquidity: null })] } },
      },
      "5m",
      1_700_000_000,
      1_699_999_895,
      100,
      600,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.address, TOKEN);
    assert.equal(rows[0]!.liquidity, 75_000);
    assert.equal(rows[0]!.isWashTrading, false);
    assert.match(rows[0]!.observationKey, /^gmgn:trending:5m:/);
    assert.throws(() => normalizeGmgnTrending({ code: 0, data: {} }, "5m", 1, 1, 100, 600), /trending envelope/);
    assert.throws(
      () => normalizeGmgnTrending({ code: 0, data: { data: { rank: [] } } }, "5m", 1, 1, 100, 600),
      /trending envelope/,
    );
  });

  it("enforces the trenches limit independently for every required category", () => {
    const rows = Array.from({ length: 60 }, (_, index) =>
      trendingRow({ address: `0x${index.toString(16).padStart(40, "0")}`, pool_address: POOL }),
    );
    const normalized = normalizeGmgnTrenches(
      { new_creation: rows, near_completion: rows, completed: rows },
      1_700_000_000,
      1_699_999_895,
      3,
      600,
    );
    assert.equal(normalized.length, 9);
    assert.deepEqual(
      normalized.map((row) => row.segment),
      [
        "new_creation",
        "new_creation",
        "new_creation",
        "near_completion",
        "near_completion",
        "near_completion",
        "completed",
        "completed",
        "completed",
      ],
    );
    assert.throws(() => normalizeGmgnTrenches({ new_creation: [] }, 1, 1, 3, 600), /trenches envelope/);
    const pumpAlias = normalizeGmgnTrenches(
      { data: { new_creation: [], pump: [trendingRow()], completed: [] } },
      1_700_000_000,
      1_699_999_895,
      3,
      600,
    );
    assert.equal(pumpAlias[0]?.segment, "near_completion");
  });

  it("sends the proven read-only trenches v2 request shape", async () => {
    let requestInit: RequestInit | undefined;
    const now = 1_700_000_000_000;
    const client = new GmgnOpenApiClient({
      apiKey: "key",
      nowMs: () => now,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input) === "https://openapi.gmgn.ai/") {
          return new Response("", { status: 404, headers: { Date: new Date(now).toUTCString() } });
        }
        requestInit = init;
        return Response.json(
          { code: 0, data: { new_creation: [], pump: [], completed: [] } },
          { headers: { Date: new Date(now).toUTCString() } },
        );
      }) as typeof fetch,
    });
    await client.getTrenches(3);
    const body = JSON.parse(String(requestInit?.body)) as Record<string, Record<string, unknown>>;
    assert.equal(body.version, "v2");
    assert.equal(body.new_creation.limit, 3);
    assert.deepEqual(body.near_completion.quote_address_type, [11, 20, 24, 12, 0]);
    assert.deepEqual(body.completed.filters, ["offchain", "onchain"]);
  });

  it("merges cross-feed provenance and qualifies only explicit safe corroborated observations", () => {
    const candidates = buildGmgnCandidates([observation("5m"), observation("1m"), observation("new_creation")], {
      minLiquidityUsd: 25_000,
      minVolume5mUsd: 10_000,
      minTrendScore: 50,
    });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.state, "qualified");
    assert.equal(candidates[0]!.score, 95);
    assert.equal(candidates[0]!.poolAddress, POOL);
    assert.equal(candidates[0]!.provenance.length, 3);

    const unsafe = buildGmgnCandidates([observation("5m", { isHoneypot: null }), observation("1m")], {
      minLiquidityUsd: 25_000,
      minVolume5mUsd: 10_000,
      minTrendScore: 50,
    })[0]!;
    assert.equal(unsafe.state, "rejected");
    assert.ok(unsafe.reasons.includes("honeypot_status_unknown"));
  });

  it("corrects a 105-second clock skew from HTTPS Date and sends no signature", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let now = 1_700_000_000_000;
    const serverMs = now + 105_000;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "https://openapi.gmgn.ai/") {
        now += 100;
        return new Response("", { status: 404, headers: { Date: new Date(serverMs).toUTCString() } });
      }
      return Response.json(
        { code: 0, data: { code: 0, data: { rank: [] } } },
        { headers: { Date: new Date(serverMs).toUTCString() } },
      );
    }) as typeof fetch;
    const client = new GmgnOpenApiClient({
      apiKey: "secret-api-key",
      fetchImpl,
      nowMs: () => now,
      uuid: () => "00000000-0000-4000-8000-000000000001",
      sleep: async () => undefined,
    });
    await client.getTrending("1h", 3);
    const request = new URL(calls[1]!.url);
    assert.equal(request.origin, "https://openapi.gmgn.ai");
    assert.equal(request.searchParams.get("timestamp"), String(Math.floor(serverMs / 1000)));
    assert.equal(request.searchParams.get("client_id"), "00000000-0000-4000-8000-000000000001");
    const headers = new Headers(calls[1]!.init?.headers);
    assert.equal(headers.get("X-APIKEY"), "secret-api-key");
    assert.equal(headers.has("X-Signature"), false);
  });

  it("refreshes once for timestamp expiry and does not retry another 401", async () => {
    const now = 1_700_000_000_000;
    let clockCalls = 0;
    let apiCalls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      const date = new Date(now + 105_000).toUTCString();
      if (url === "https://openapi.gmgn.ai/") {
        clockCalls += 1;
        return new Response("", { status: 404, headers: { Date: date } });
      }
      apiCalls += 1;
      if (apiCalls === 1) {
        return Response.json(
          { code: 401, error: "AUTH_TIMESTAMP_EXPIRED", message: "timestamp expired" },
          { status: 401, headers: { Date: date } },
        );
      }
      return Response.json({ code: 0, data: { code: 0, data: { rank: [] } } }, { headers: { Date: date } });
    }) as typeof fetch;
    const client = new GmgnOpenApiClient({ apiKey: "key", fetchImpl, nowMs: () => now, sleep: async () => undefined });
    await client.getTrending("5m", 3);
    assert.equal(apiCalls, 2);
    assert.equal(clockCalls, 2);

    const denied = new GmgnOpenApiClient({
      apiKey: "key",
      nowMs: () => now,
      sleep: async () => undefined,
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://openapi.gmgn.ai/") {
          return new Response("", { status: 404, headers: { Date: new Date(now).toUTCString() } });
        }
        return Response.json(
          { code: 401, error: "AUTH_DENIED", message: "denied" },
          { status: 401, headers: { Date: new Date(now).toUTCString() } },
        );
      }) as typeof fetch,
    });
    await assert.rejects(() => denied.getTrending("5m", 3), /auth_denied/);
  });

  it("keeps post-refresh rate-limit retries within the bounded request budget", async () => {
    const now = 1_700_000_000_000;
    let clockCalls = 0;
    let apiCalls = 0;
    const client = new GmgnOpenApiClient({
      apiKey: "key",
      nowMs: () => now,
      sleep: async () => undefined,
      fetchImpl: (async (input: string | URL | Request) => {
        const date = new Date(now).toUTCString();
        if (String(input) === "https://openapi.gmgn.ai/") {
          clockCalls += 1;
          return new Response("", { status: 404, headers: { Date: date } });
        }
        apiCalls += 1;
        if (apiCalls === 1) {
          return Response.json(
            { code: 401, error: "AUTH_TIMESTAMP_EXPIRED", message: "timestamp expired" },
            { status: 401, headers: { Date: date } },
          );
        }
        return Response.json({ error: "rate limited" }, { status: 429, headers: { Date: date, "Retry-After": "1" } });
      }) as typeof fetch,
    });

    await assert.rejects(() => client.getTrending("5m", 3), /rate_limit_exhausted/);
    assert.equal(clockCalls, 2);
    assert.equal(apiCalls, 4);
  });

  it("fails closed for missing or unreasonable server time and bounds 429 retries", async () => {
    const missingDate = new GmgnOpenApiClient({
      apiKey: "key",
      fetchImpl: (async () => new Response("", { status: 404 })) as typeof fetch,
    });
    await assert.rejects(() => missingDate.getTrending("5m", 3), /clock_date_invalid/);

    const unreasonableDate = new GmgnOpenApiClient({
      apiKey: "key",
      nowMs: () => 1_700_000_000_000,
      fetchImpl: (async () =>
        new Response("", {
          status: 404,
          headers: { Date: new Date(1_700_000_700_000).toUTCString() },
        })) as typeof fetch,
    });
    await assert.rejects(() => unreasonableDate.getTrending("5m", 3), /clock_offset_invalid/);

    let calls = 0;
    const limited = new GmgnOpenApiClient({
      apiKey: "sensitive-api-key",
      nowMs: () => 1_700_000_000_000,
      sleep: async () => undefined,
      fetchImpl: (async (input: string | URL | Request) => {
        if (String(input) === "https://openapi.gmgn.ai/") {
          return new Response("", { status: 404, headers: { Date: new Date(1_700_000_000_000).toUTCString() } });
        }
        calls += 1;
        return Response.json(
          { error: "rate limited sensitive-api-key" },
          { status: 429, headers: { Date: new Date(1_700_000_000_000).toUTCString(), "Retry-After": "1" } },
        );
      }) as typeof fetch,
    });
    await assert.rejects(
      () => limited.getTrending("5m", 3),
      (error: unknown) => {
        assert.doesNotMatch(String(error), /sensitive-api-key/);
        assert.match(String(error), /rate_limit_exhausted/);
        return true;
      },
    );
    assert.equal(calls, 3);
  });

  it("lets RPC verify shortlisted candidates but never create one", async () => {
    const candidate: GmgnCandidate = {
      subjectType: "token",
      subjectAddress: TOKEN,
      poolAddress: POOL,
      windowStart: 1_699_999_800,
      state: "qualified",
      score: 95,
      reasons: [],
      provenance: [],
      evidence: {},
      verified: false,
      verificationReasons: [],
    };
    const calls: string[] = [];
    const verified = await verifyGmgnCandidates([candidate], {
      rpcUrls: ["https://rpc.example"],
      transport: async (_url, method, params) => {
        calls.push(`${method}:${String(params[0] ?? "")}`);
        if (method === "eth_chainId") return "0x1237";
        if (method === "eth_getCode") return "0x6000";
        throw new Error("unexpected RPC method");
      },
      sleep: async () => undefined,
    });
    assert.equal(verified.length, 1);
    assert.equal(verified[0]!.verified, true);
    assert.deepEqual(calls, [`eth_chainId:`, `eth_getCode:${TOKEN}`, `eth_getCode:${POOL}`]);
    assert.deepEqual(
      await verifyGmgnCandidates([], {
        rpcUrls: ["https://rpc.example"],
        transport: async () => {
          throw new Error("RPC should not run");
        },
      }),
      [],
    );

    const malformedChain = await verifyGmgnCandidates([candidate], {
      rpcUrls: ["https://rpc.example"],
      transport: async (_url, method) => (method === "eth_chainId" ? "0x1237junk" : "0x6000"),
      sleep: async () => undefined,
    });
    assert.equal(malformedChain[0]?.verified, false);
    assert.deepEqual(malformedChain[0]?.verificationReasons, ["rpc_chain_id_mismatch_or_unavailable"]);
  });

  it("enforces the hard 20-address RPC verification budget", async () => {
    const candidates = Array.from(
      { length: 21 },
      (_, index): GmgnCandidate => ({
        subjectType: "token",
        subjectAddress: `0x${(index + 1).toString(16).padStart(40, "0")}`,
        poolAddress: null,
        windowStart: 1_699_999_800,
        state: "qualified",
        score: 70,
        reasons: [],
        provenance: [],
        evidence: {},
        verified: false,
        verificationReasons: [],
      }),
    );
    let codeCalls = 0;
    const verified = await verifyGmgnCandidates(candidates, {
      rpcUrls: ["https://rpc.example"],
      maxAddresses: 999,
      transport: async (_url, method) => {
        if (method === "eth_chainId") return "0x1237";
        codeCalls += 1;
        return "0x6000";
      },
      sleep: async () => undefined,
    });
    assert.equal(codeCalls, 20);
    assert.equal(verified.filter((row) => row.verified).length, 20);
    assert.deepEqual(verified.at(-1)?.verificationReasons, ["rpc_verify_limit_reached"]);
  });

  it("aborts RPC verification before another endpoint or retry can start", async () => {
    const controller = new AbortController();
    let calls = 0;
    let sleepCalls = 0;
    await assert.rejects(
      () =>
        verifyGmgnCandidates(
          [
            {
              subjectType: "token",
              subjectAddress: TOKEN,
              poolAddress: POOL,
              windowStart: 1_699_999_800,
              state: "qualified",
              score: 95,
              reasons: [],
              provenance: [],
              evidence: {},
              verified: false,
              verificationReasons: [],
            },
          ],
          {
            rpcUrls: ["https://rpc.example"],
            signal: controller.signal,
            transport: async () => {
              calls += 1;
              controller.abort();
              throw new Error("transport interrupted");
            },
            sleep: async () => {
              sleepCalls += 1;
              throw new Error("retry sleep should not start");
            },
          },
        ),
      /gmgn_request_aborted/,
    );
    assert.equal(calls, 1);
    assert.equal(sleepCalls, 0);
  });

  it("persists duplicate polls idempotently with cross-feed provenance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-gmgn-store-"));
    const path = join(dir, "gmgn.sqlite");
    const observations = [observation("5m"), observation("1m"), observation("new_creation")];
    const candidate = buildGmgnCandidates(observations, {
      minLiquidityUsd: 25_000,
      minVolume5mUsd: 10_000,
      minTrendScore: 50,
    })[0]!;
    candidate.verified = true;
    const store = new RobinhoodGmgnStore(path);
    try {
      store.persistTick({ observations, candidates: [candidate], now: 1_700_000_000, retentionDays: 30 });
      store.persistTick({ observations, candidates: [candidate], now: 1_700_000_001, retentionDays: 30 });
      assert.equal(store.count("gmgn_observations"), 3);
      assert.equal(store.count("gmgn_candidates"), 1);
      assert.equal(store.sourceHealth()?.status, "ok");
    } finally {
      store.close();
    }
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db.prepare("SELECT provenance_json,verified FROM gmgn_candidates").get() as {
        provenance_json: string;
        verified: number;
      };
      assert.equal(JSON.parse(row.provenance_json).length, 3);
      assert.equal(row.verified, 1);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rolls back the whole tick on a candidate write failure and records source failures separately", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-gmgn-atomic-"));
    const path = join(dir, "gmgn.sqlite");
    const store = new RobinhoodGmgnStore(path);
    const bad = {
      ...buildGmgnCandidates([observation("5m"), observation("1m")], {
        minLiquidityUsd: 25_000,
        minVolume5mUsd: 10_000,
        minTrendScore: 50,
      })[0]!,
      subjectAddress: undefined,
    } as unknown as GmgnCandidate;
    try {
      assert.throws(() =>
        store.persistTick({
          observations: [observation("5m"), observation("1m")],
          candidates: [bad],
          now: 1_700_000_000,
          retentionDays: 30,
        }),
      );
      assert.equal(store.count("gmgn_observations"), 0);
      assert.equal(store.count("gmgn_candidates"), 0);
      assert.equal(store.sourceHealth(), null);
      store.recordFailure(1_700_000_001, "gmgn_schema_drift");
      assert.equal(store.sourceHealth()?.status, "error");
      assert.equal(store.sourceHealth()?.consecutive_failures, 1);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drains every required feed before recording one failed tick", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-gmgn-drain-"));
    const path = join(dir, "gmgn.sqlite");
    let release: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const allStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let starts = 0;
    let completed = false;
    const delayed = new Promise<{ payload: unknown; upstreamObservedAt: number }>((resolve) => {
      release = () =>
        resolve({ payload: { code: 0, data: { code: 0, data: { rank: [] } } }, upstreamObservedAt: 1_700_000_000 });
    });
    const client = {
      getTrending(interval: string) {
        starts += 1;
        if (starts === 4) markStarted?.();
        if (interval === "1m") return Promise.reject(new Error("gmgn_trending_transport_exhausted"));
        return delayed;
      },
      getTrenches() {
        starts += 1;
        if (starts === 4) markStarted?.();
        return delayed;
      },
    };
    try {
      const collection = collectRobinhoodGmgn({ config: config(), dbPath: path, client, now: () => 1_700_000_000 });
      collection.finally(() => {
        completed = true;
      });
      await allStarted;
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(completed, false);
      release?.();
      const result = await collection;
      assert.equal(result.status, "source_unhealthy");
      const store = new RobinhoodGmgnStore(path);
      assert.equal(store.count("gmgn_observations"), 0);
      assert.equal(store.sourceHealth()?.status, "error");
      store.close();
    } finally {
      release?.();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a stale required feed without persisting observations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-gmgn-stale-"));
    const path = join(dir, "gmgn.sqlite");
    const response = {
      payload: { code: 0, data: { code: 0, data: { rank: [] } } },
      upstreamObservedAt: 1_699_999_000,
    };
    const client = {
      getTrending: async () => response,
      getTrenches: async () => ({
        payload: { new_creation: [], near_completion: [], completed: [] },
        upstreamObservedAt: response.upstreamObservedAt,
      }),
    };
    try {
      const result = await collectRobinhoodGmgn({ config: config(), dbPath: path, client, now: () => 1_700_000_000 });
      assert.equal(result.status, "source_unhealthy");
      assert.equal(result.errorCategory, "gmgn_upstream_stale");
      const store = new RobinhoodGmgnStore(path);
      assert.equal(store.count("gmgn_observations"), 0);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("isolates GMGN collector failures in the trade scheduler and forwards cancellation", async () => {
    const lines: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const result = await runRobinhoodGmgnCollectorJob(
      config(),
      async (input) => {
        assert.equal(input.signal, controller.signal);
        throw new Error("sensitive-api-key should never escape");
      },
      (line) => lines.push(line),
      controller.signal,
    );
    assert.equal(result, null);
    assert.match(lines[0] ?? "", /robinhood-gmgn.*failed/);
    assert.doesNotMatch(lines[0] ?? "", /sensitive-api-key/);
  });
});
