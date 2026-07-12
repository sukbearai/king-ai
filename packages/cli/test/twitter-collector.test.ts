import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cliFailure, cliSuccess, type CliRunResult } from "../src/trade/cli-result.js";
import {
  fetchOpencliBrowserTweets,
  normalizeTweet,
  parseTwitterMetric,
  resolveTwitterCollectorOptions,
  type TwitterCollectorOptions,
} from "../src/trade/twitter-collector.js";

type Runner = (args: string[], timeoutMs?: number) => Promise<CliRunResult<unknown[]>>;

const noWait = async () => {};

function options(overrides: Partial<TwitterCollectorOptions> = {}): TwitterCollectorOptions {
  return {
    collectLimit: 120,
    scrollRounds: 10,
    scrollWaitMs: 800,
    stagnantRounds: 2,
    ...overrides,
  };
}

function timelineRunner(
  snapshots: Array<Array<Record<string, unknown>>>,
  openResults: boolean[] = [true],
): { runner: Runner; openCount: () => number } {
  let evalIndex = 0;
  let opens = 0;
  const runner: Runner = async (args) => {
    if (args.includes("open")) {
      const ok = openResults[Math.min(opens, openResults.length - 1)] ?? true;
      opens += 1;
      return ok ? cliSuccess([]) : cliFailure([], "open failed");
    }
    if (args.includes("eval")) {
      const rows = snapshots[Math.min(evalIndex, snapshots.length - 1)] ?? [];
      evalIndex += 1;
      return cliSuccess([{ rows, scanned: rows.length }]);
    }
    return cliSuccess([]);
  };
  return { runner, openCount: () => opens };
}

describe("resolveTwitterCollectorOptions", () => {
  it("uses bounded defaults and supports legacy limit", () => {
    assert.deepEqual(resolveTwitterCollectorOptions({}), {
      collectLimit: 120,
      scrollRounds: 10,
      scrollWaitMs: 800,
      stagnantRounds: 2,
    });
    assert.deepEqual(resolveTwitterCollectorOptions({ limit: 40, scroll_rounds: 3, stagnant_rounds: 8 }), {
      collectLimit: 40,
      scrollRounds: 3,
      scrollWaitMs: 800,
      stagnantRounds: 3,
    });
    assert.deepEqual(
      resolveTwitterCollectorOptions({
        collect_limit: 9999,
        scroll_rounds: 0,
        scroll_wait_ms: 1,
        stagnant_rounds: 0,
      }),
      { collectLimit: 500, scrollRounds: 1, scrollWaitMs: 100, stagnantRounds: 1 },
    );
  });
});

describe("parseTwitterMetric", () => {
  it("parses localized compact metrics", () => {
    assert.equal(parseTwitterMetric("1,234 Likes"), 1234);
    assert.equal(parseTwitterMetric("1.2K views"), 1200);
    assert.equal(parseTwitterMetric("3.4M"), 3_400_000);
    assert.equal(parseTwitterMetric("2B"), 2_000_000_000);
    assert.equal(parseTwitterMetric("1.5万 次查看"), 15_000);
    assert.equal(parseTwitterMetric("0.8亿"), 80_000_000);
    assert.equal(parseTwitterMetric("No likes"), 0);
  });

  it("normalizes replies and engagement fields", () => {
    assert.deepEqual(normalizeTweet({ id: "1", text: "BTC", replies: "2", retweets: "3", likes: "4", views: "1.2K" }), {
      id: "1",
      text: "BTC",
      author: "",
      created_at: "",
      replies: 2,
      retweets: 3,
      likes: 4,
      views: 1200,
      url: "",
    });
  });
});

describe("fetchOpencliBrowserTweets", () => {
  it("merges overlapping virtual DOM snapshots and stops when stagnant", async () => {
    const { runner } = timelineRunner([
      [
        { id: "1", text: "one" },
        { id: "2", text: "two" },
      ],
      [
        { id: "2", text: "two" },
        { id: "3", text: "three" },
      ],
      [
        { id: "2", text: "two" },
        { id: "3", text: "three" },
      ],
    ]);
    const result = await fetchOpencliBrowserTweets(options({ stagnantRounds: 1 }), runner, noWait);
    assert.equal(result.rows.length, 3);
    assert.equal(result.rounds, 3);
    assert.equal(result.scanned, 6);
    assert.equal(result.duplicates, 3);
  });

  it("deduplicates id-less rows by text and respects collectLimit", async () => {
    const { runner } = timelineRunner([
      [{ text: "same text" }, { text: "same text" }, { text: "different text" }, { text: "third text" }],
    ]);
    const result = await fetchOpencliBrowserTweets(options({ collectLimit: 3 }), runner, noWait);
    assert.equal(result.rows.length, 3);
    assert.equal(result.rounds, 1);
    assert.equal(result.duplicates, 1);
  });

  it("retries one failed browser open", async () => {
    const { runner, openCount } = timelineRunner([[{ id: "1", text: "one" }]], [false, true]);
    const result = await fetchOpencliBrowserTweets(options({ collectLimit: 1 }), runner, noWait);
    assert.equal(openCount(), 2);
    assert.equal(result.rows.length, 1);
  });

  it("retries one empty browser timeline", async () => {
    const { runner, openCount } = timelineRunner([[], [{ id: "1", text: "one" }]]);
    const result = await fetchOpencliBrowserTweets(options({ collectLimit: 1, stagnantRounds: 1 }), runner, noWait);
    assert.equal(openCount(), 2);
    assert.equal(result.rows.length, 1);
  });

  it("waits longer after a stagnant snapshot before probing again", async () => {
    const { runner } = timelineRunner([
      [{ id: "1", text: "one" }],
      [{ id: "1", text: "one" }],
      [
        { id: "1", text: "one" },
        { id: "2", text: "two" },
      ],
    ]);
    const waits: number[] = [];
    const result = await fetchOpencliBrowserTweets(options({ collectLimit: 2 }), runner, async (ms) => {
      waits.push(ms);
    });
    assert.deepEqual(waits, [800, 1600]);
    assert.equal(result.rows.length, 2);
  });
});
