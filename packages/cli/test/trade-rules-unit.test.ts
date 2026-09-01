import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cliFailure, cliSuccess } from "../src/trade/cli-result.js";
import { directionLabel, createAlert } from "../src/trade/alert-rule.js";
import { parseMemeTradeAmount } from "../src/trade/rules/rule-e-meme.js";
import {
  fetchTweets,
  celebrityAlertSeverity,
  celebrityClassificationLimit,
  extractChainFmRefs,
  groundEntitiesInText,
  isCelebritySeenRecordActive,
  isLikelyTweetUiFragment,
  NON_ALPHA_SEEN_SECONDS,
  parseFailMarkTtl,
  parseSeenStateLines,
  resolveCelebrityAlphaDecision,
  selectCelebrityCandidates,
  type CelebrityFetchRunner,
  type CelebrityTweetCandidate,
} from "../src/trade/rules/rule-t-celebrity.js";
import { buildPanewsUnclassifiedAlert } from "../src/trade/rules/rule-q-panews.js";
import { createRule, listRuleIds } from "../src/trade/rules/registry.js";

describe("parseMemeTradeAmount", () => {
  it("parses K/M suffix amounts", () => {
    assert.equal(parseMemeTradeAmount("1.5K"), 1500);
    assert.equal(parseMemeTradeAmount("2M"), 2_000_000);
    assert.equal(parseMemeTradeAmount("$3,500"), 3500);
  });
});

describe("buildPanewsUnclassifiedAlert", () => {
  it("creates info alert with desc or fallback detail", () => {
    const withDesc = buildPanewsUnclassifiedAlert({ title: "Test", desc: "body" });
    assert.equal(withDesc.severity, "info");
    assert.equal(withDesc.title, "Test");
    assert.match(withDesc.detail, /body/);

    const bare = buildPanewsUnclassifiedAlert({ title: "Only title" });
    assert.match(bare.detail, /agent 分类暂不可用/);
  });
});

describe("directionLabel", () => {
  it("uses direction field when set", () => {
    assert.equal(
      directionLabel(
        createAlert({
          ruleId: "stocks",
          severity: "info",
          title: "t",
          detail: "d",
          direction: -1,
        }),
      ),
      "跌破",
    );
    assert.equal(
      directionLabel(
        createAlert({
          ruleId: "stocks",
          severity: "info",
          title: "t",
          detail: "d",
          direction: 1,
        }),
      ),
      "突破",
    );
  });
});

describe("celebrity rule helpers", () => {
  it("extracts chain.fm refs from tweet text", () => {
    const text = "Check https://chain.fm/token/solana/AbC123 and https://chain.fm/token/bsc/0xdead";
    const refs = extractChainFmRefs(text);
    assert.equal(refs.length, 2);
    assert.equal(refs[0]!.chain, "solana");
    assert.equal(refs[0]!.address, "AbC123");
    assert.match(refs[0]!.url, /chain\.fm\/token\/solana\/AbC123/);
  });

  it("maps alpha type, entity count, and confidence to severity autonomously", () => {
    assert.equal(celebrityAlertSeverity("endorsement", 1, 0.9), "warning");
    assert.equal(celebrityAlertSeverity("endorsement", 1, 0.5), "info");
    assert.equal(celebrityAlertSeverity("naming", 3, 0.8), "warning");
    assert.equal(celebrityAlertSeverity("naming", 1, 0.95), "warning");
    assert.equal(celebrityAlertSeverity("naming", 1, 0.8), "info");
  });

  it("grounds entities in tweet text and drops hallucinations", () => {
    const { kept, dropped } = groundEntitiesInText("Just bought $PEPE and DOGE forever", [
      "PEPE",
      "DOGE",
      "BONK",
      "AI",
    ]);
    assert.deepEqual(kept, ["PEPE", "DOGE"]);
    assert.ok(dropped.includes("BONK"));
    assert.ok(dropped.includes("AI"));
  });

  it("resolveCelebrityAlphaDecision keeps LLM autonomy with ledger rails only", () => {
    const ok = resolveCelebrityAlphaDecision(
      {
        is_alpha: true,
        alpha_type: "endorsement",
        confidence: 0.88,
        reason: "点名买入",
        entities: ["PEPE", "FAKE"],
      },
      "Elon says buy $PEPE now",
    );
    assert.equal(ok.meta.is_alpha, true);
    assert.deepEqual(ok.entities, ["PEPE"]);
    assert.ok(ok.meta.grounded_out?.includes("FAKE"));

    const lowConf = resolveCelebrityAlphaDecision(
      { is_alpha: true, alpha_type: "naming", confidence: 0.2, reason: "maybe", entities: ["PEPE"] },
      "love $PEPE",
    );
    assert.equal(lowConf.meta.is_alpha, false);

    const noEntity = resolveCelebrityAlphaDecision(
      { is_alpha: true, alpha_type: "policy", confidence: 0.9, reason: "监管", entities: [] },
      "crypto needs clarity",
    );
    assert.equal(noEntity.meta.is_alpha, false);

    const parseFail = resolveCelebrityAlphaDecision(null, "x");
    assert.equal(parseFail.meta.parse_failed, true);
  });

  it("filters browser UI fragments before LLM extraction", () => {
    assert.equal(
      isLikelyTweetUiFragment(
        `Donald J. Trump
@realDonaldTrump
·
May 23
0:20
72K
112K
909K
99M`,
        "realDonaldTrump",
      ),
      true,
    );
    assert.equal(isLikelyTweetUiFragment("Launching a new token today on Solana", "realDonaldTrump"), false);
  });

  it("expires non-alpha seen records sooner than terminal records", () => {
    const now = 10_000;
    assert.equal(NON_ALPHA_SEEN_SECONDS, 6 * 3600);
    assert.equal(isCelebritySeenRecordActive({ id: "tweet-1", ts: now - 3600, ttl_seconds: 7200 }, now), true);
    assert.equal(isCelebritySeenRecordActive({ id: "tweet-1", ts: now - 7201, ttl_seconds: 7200 }, now), false);
    assert.equal(isCelebritySeenRecordActive({ id: "tweet-2", ts: now - 2 * 86400 }, now), true);
    assert.equal(isCelebritySeenRecordActive({ id: "tweet-2", ts: now - 4 * 86400 }, now), false);
  });

  it("parseFailMarkTtl uses bounded exponential retry backoff", () => {
    assert.equal(parseFailMarkTtl(1), 900);
    assert.equal(parseFailMarkTtl(2), 1800);
    assert.equal(parseFailMarkTtl(3), 3600);
    assert.equal(parseFailMarkTtl(4), 3600);
  });

  it("parseSeenStateLines uses latest records and bounded retry history", () => {
    const now = 1_000_000;
    const lines = [
      JSON.stringify({ id: "active-1", ts: now - 60, ttl_seconds: 86400 * 3 }),
      JSON.stringify({ id: "expired-1", ts: now - 10_000, ttl_seconds: 900 }),
      JSON.stringify({ id: "pf-1", ts: now - 100, ttl_seconds: 900 }),
      JSON.stringify({ id: "pf-1", ts: now - 50, ttl_seconds: 900 }),
      "not-json{{{",
      JSON.stringify({ id: "other", ts: now - 10, ttl_seconds: 300 }),
    ];
    const { active, parseFails } = parseSeenStateLines(lines, now);
    assert.equal(active.has("active-1"), true);
    assert.equal(active.has("expired-1"), false);
    assert.equal(active.has("pf-1"), true);
    assert.equal(active.has("other"), true);
    assert.equal(parseFails.get("pf-1"), 2);
    assert.equal(parseFails.get("expired-1"), 1);
    assert.equal(parseFails.has("active-1"), false);
    assert.equal(parseFails.has("other"), false);

    const latestWins = parseSeenStateLines(
      [
        JSON.stringify({ id: "latest-1", ts: now - 2_000, ttl_seconds: 86400 * 3 }),
        JSON.stringify({ id: "latest-1", ts: now - 1_000, ttl_seconds: 900 }),
      ],
      now,
    );
    assert.equal(latestWins.active.has("latest-1"), false);

    const expiredHistory = parseSeenStateLines(
      [JSON.stringify({ id: "old-parse", ts: now - 7 * 3600, ttl_seconds: 900 })],
      now,
    );
    assert.equal(expiredHistory.parseFails.has("old-parse"), false);

    const explicitAttempts = parseSeenStateLines(
      [
        JSON.stringify({
          id: "explicit-parse",
          ts: now - 1800,
          ttl_seconds: 1800,
          outcome: "parse_failed",
          attempts: 2,
        }),
      ],
      now,
    );
    assert.equal(explicitAttempts.parseFails.get("explicit-parse"), 2);

    const legacyRecoveryLines = [
      JSON.stringify({ id: "legacy-recovery", ts: now - 1800, ttl_seconds: 900 }),
      JSON.stringify({ id: "legacy-recovery", ts: now - 600, ttl_seconds: 86400 * 3 }),
    ];
    const legacyRecovery = parseSeenStateLines(legacyRecoveryLines, now);
    assert.equal(legacyRecovery.active.has("legacy-recovery"), true);
    const afterLegacyCap = parseSeenStateLines(legacyRecoveryLines, now + 3601);
    assert.equal(afterLegacyCap.active.has("legacy-recovery"), false);
    const afterLegacyWindow = parseSeenStateLines(legacyRecoveryLines, now + 7 * 3600);
    assert.equal(afterLegacyWindow.active.has("legacy-recovery"), false);
    const muchLater = parseSeenStateLines(legacyRecoveryLines, now + 30 * 86400);
    assert.equal(muchLater.active.has("legacy-recovery"), false);

    const ordinaryTerminal = parseSeenStateLines(
      [JSON.stringify({ id: "ordinary-terminal", ts: now - 2 * 3600, ttl_seconds: 86400 * 3 })],
      now,
    );
    assert.equal(ordinaryTerminal.active.has("ordinary-terminal"), true);
  });

  it("clamps the per-tick celebrity classification limit", () => {
    assert.equal(celebrityClassificationLimit(undefined), 8);
    assert.equal(celebrityClassificationLimit(0), 1);
    assert.equal(celebrityClassificationLimit(99.9), 50);
  });

  it("selects newest candidates and leaves overflow unselected", () => {
    const candidates: CelebrityTweetCandidate[] = [
      {
        account: "one",
        id: "old",
        text: "old candidate",
        tweet: { id: "old", created_at: "2026-07-12T00:00:00.000Z" },
        discoveryIndex: 0,
      },
      {
        account: "two",
        id: "invalid-time",
        text: "invalid timestamp",
        tweet: { id: "invalid-time", created_at: "not-a-date" },
        discoveryIndex: 1,
      },
      {
        account: "three",
        id: "new",
        text: "new candidate",
        tweet: { id: "new", created_at: "2026-07-13T00:00:00.000Z" },
        discoveryIndex: 2,
      },
    ];
    const { selected, overflow } = selectCelebrityCandidates(candidates, 2);
    assert.deepEqual(
      selected.map((candidate) => candidate.id),
      ["new", "old"],
    );
    assert.deepEqual(
      overflow.map((candidate) => candidate.id),
      ["invalid-time"],
    );
  });

  it("fetchTweets returns no-results but raises degraded collection states", async () => {
    const noResultsRunner = async (args: string[]) =>
      args.includes("eval")
        ? cliSuccess([
            { title: "Search", url: "https://x.com/search", text: 'No results for "from:alice"', articles: 0 },
          ])
        : cliSuccess([]);
    assert.deepEqual(await fetchTweets("alice", 10, noResultsRunner), []);

    for (const status of ["auth-required", "challenge"] as const) {
      const runner = async (args: string[]) =>
        args.includes("eval")
          ? cliSuccess([
              {
                title: status === "challenge" ? "Challenge" : "Log in",
                url: "https://x.com/search",
                text: status === "challenge" ? "verify you are human" : "sign in to X",
                articles: 0,
              },
            ])
          : cliSuccess([]);
      await assert.rejects(() => fetchTweets("alice", 10, runner), new RegExp(`@alice ${status}`));
    }
  });

  it("fetchTweets retries open, eval, unknown, and empty-ok failures", async () => {
    const scenarios: Array<{ name: string; runner: CelebrityFetchRunner }> = [
      {
        name: "open",
        runner: async (args) => (args.includes("open") ? cliFailure([], "open failed") : cliSuccess([])),
      },
      {
        name: "eval",
        runner: async (args) => (args.includes("eval") ? cliFailure([], "eval failed") : cliSuccess([])),
      },
      {
        name: "unknown",
        runner: async (args) =>
          args.includes("eval")
            ? cliSuccess([{ title: "Search", url: "https://x.com/search", text: "loaded", articles: 0 }])
            : cliSuccess([]),
      },
      {
        name: "empty-ok",
        runner: async (args) =>
          args.includes("eval")
            ? cliSuccess([{ title: "Search", url: "https://x.com/search", text: "loaded", articles: 1, tweets: [] }])
            : cliSuccess([]),
      },
    ];
    for (const scenario of scenarios) {
      await assert.rejects(
        () => fetchTweets("alice", 10, scenario.runner),
        new RegExp(`@alice.*${scenario.name === "empty-ok" ? "no usable tweet rows" : scenario.name}`),
      );
    }
  });

  it("fetchTweets returns usable rows after the retry structure succeeds", async () => {
    const calls: string[][] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      return args.includes("eval")
        ? cliSuccess([
            {
              title: "Search",
              url: "https://x.com/search",
              text: "loaded",
              articles: 1,
              tweets: [{ id: "tweet-1", text: "A usable tweet" }],
            },
          ])
        : cliSuccess([]);
    };
    const rows = await fetchTweets("alice", 10, runner, "trade-robinhood-search");
    assert.deepEqual(rows, [{ id: "tweet-1", text: "A usable tweet" }]);
    assert.ok(calls.every((args) => args[1] === "trade-robinhood-search"));
  });
});

describe("slim registry", () => {
  it("loads every listed rule id", () => {
    for (const id of listRuleIds()) {
      assert.ok(createRule(id), `slim rule ${id}`);
    }
  });
});
