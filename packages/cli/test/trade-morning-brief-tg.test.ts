import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactSummaryFallback } from "../src/trade/llm-summarize.js";
import {
  compactTelegramSummary,
  formatTwitterSourceNotes,
  parseTelegramChannels,
  parseTgRecentMessages,
  preprocessTelegramBody,
  formatTwitterSummaryHeading,
  isTradeRelevantTweet,
  rankTwitterCandidates,
  resolveBriefingPushTg,
  resolveTwitterSummaryCandidateLimit,
} from "../src/trade/morning-brief.js";
import { chunkTelegramMessage } from "../src/trade/telegram.js";
import { countRecentCacheRecords } from "../src/trade/twitter-cache.js";

describe("parseTelegramChannels", () => {
  it("maps label to tg chat name", () => {
    const rows = parseTelegramChannels({
      方程式快讯: "方程式新闻 BWEnews",
      "传统金融/宏观": "@BWETradFi |方程式财经（传统金融新闻）",
      "meme 链上监控": "meme链上监控",
    });
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], { label: "方程式快讯", chat: "方程式新闻 BWEnews" });
    assert.deepEqual(rows[2], { label: "meme 链上监控", chat: "meme链上监控" });
  });
});

describe("parseTgRecentMessages", () => {
  it("extracts content from tg recent --json output", () => {
    const raw = JSON.stringify({
      ok: true,
      data: [{ content: "hello" }, { content: "world" }, { content: "" }],
    });
    assert.deepEqual(parseTgRecentMessages(raw), ["hello", "world"]);
  });

  it("returns empty array for blank output", () => {
    assert.deepEqual(parseTgRecentMessages(""), []);
  });
});

describe("countRecentCacheRecords", () => {
  it("counts recent vs stale tweets from cache stats shape", async () => {
    const stats = await countRecentCacheRecords(24, "/nonexistent/twitter_cache.jsonl");
    assert.deepEqual(stats, { total: 0, recent: 0, stale: 0, invalid: 0 });
  });
});

describe("preprocessTelegramBody", () => {
  it("deduplicates meme transfer spam and strips markdown links", () => {
    const raw = [
      "⬇️ [CZ](https://chain.fm/account) received 200k Fomo3D from 0xce...25c6",
      "⬇️ [CZ](https://chain.fm/account) received 200k Fomo3D from 0xce...25c6",
      "⚙️",
      "⬇️ [CZ](https://chain.fm/account) received 100k Fomo3D from 0xb0...ea61",
    ].join("\n");
    const out = preprocessTelegramBody(raw);
    assert.equal(out.split("\n").length, 2);
    assert.match(out, /CZ.*received 200k Fomo3D/);
    assert.equal(out.includes("https://"), false);
  });
});

describe("resolveBriefingPushTg", () => {
  it("prefers explicit CLI flag over config", () => {
    const config = { briefing: { push_telegram: true } };
    assert.equal(resolveBriefingPushTg(config, { pushTg: false }), false);
    assert.equal(resolveBriefingPushTg(config, { pushTg: true }), true);
  });

  it("falls back to briefing.push_telegram when flag is unset", () => {
    assert.equal(resolveBriefingPushTg({ briefing: { push_telegram: true } }), true);
    assert.equal(resolveBriefingPushTg({ briefing: { push_telegram: false } }), false);
    assert.equal(resolveBriefingPushTg({}), false);
  });
});

describe("formatTwitterSummaryHeading", () => {
  it("reports the cache, filtered, and candidate funnel", () => {
    assert.equal(
      formatTwitterSummaryHeading(24, { cached: 60, filtered: 42, candidates: 30 }),
      "🐦 Twitter 时间线（最近 24h，缓存 60 条，筛后 42 条，从 30 条候选中提炼）\n",
    );
    assert.equal(
      formatTwitterSummaryHeading(24, { cached: 0, filtered: 0, candidates: 0 }),
      "🐦 Twitter 时间线（最近 24h，缓存 0 条，筛后 0 条，从 0 条候选中提炼）\n",
    );
  });

  it("keeps the legacy heading shape when count is unknown", () => {
    assert.equal(formatTwitterSummaryHeading(24), "🐦 Twitter 时间线（最近 24h）\n");
  });

  it("reports displayed tweets when LLM summarization is disabled", () => {
    assert.equal(
      formatTwitterSummaryHeading(24, { cached: 60, filtered: 17, candidates: 12 }, false),
      "🐦 Twitter 时间线（最近 24h，缓存 60 条，筛后 17 条，展示 12 条高相关推文）\n",
    );
  });
});

describe("Twitter candidate selection", () => {
  it("clamps the configured summary candidate limit", () => {
    assert.equal(resolveTwitterSummaryCandidateLimit({}), 30);
    assert.equal(resolveTwitterSummaryCandidateLimit({ summary_candidate_limit: 2 }), 5);
    assert.equal(resolveTwitterSummaryCandidateLimit({ summary_candidate_limit: 45 }), 45);
    assert.equal(resolveTwitterSummaryCandidateLimit({ summary_candidate_limit: 100 }), 60);
  });

  it("ranks engagement first and recency second", () => {
    const ranked = rankTwitterCandidates([
      { entry: { id: "old", created_at: "2026-07-10T01:00:00Z" }, formatted: "@a: old" },
      { entry: { id: "new", created_at: "2026-07-10T03:00:00Z" }, formatted: "@b: new" },
      { entry: { id: "popular", created_at: "2026-07-10T00:00:00Z" }, formatted: "@c: popular [5❤️]" },
    ]);
    assert.deepEqual(
      ranked.map((candidate) => candidate.entry.id),
      ["popular", "new", "old"],
    );
  });
});

describe("formatTwitterSourceNotes", () => {
  const candidates = [
    {
      author: "alice",
      text: "BTC update",
      created_at: "2026-07-10T05:00:00Z",
      url: "https://x.com/alice/status/1",
    },
    {
      author: "bob",
      text: "Fed update",
      created_at: "2026-07-10T06:30:00Z",
      url: "https://x.com/bob/status/2",
    },
  ];

  it("keeps cited author, time, and source URL", () => {
    const notes = formatTwitterSourceNotes("1. 联储信号 [T2]\n2. BTC 信号 [T1]", candidates);
    assert.deepEqual(notes, [
      "[T2] @bob · 07-10 14:30 UTC+8 · https://x.com/bob/status/2",
      "[T1] @alice · 07-10 13:00 UTC+8 · https://x.com/alice/status/1",
    ]);
  });

  it("returns no notes for invalid citations", () => {
    assert.deepEqual(formatTwitterSourceNotes("无引用", candidates), []);
  });
});

describe("compactTelegramSummary", () => {
  it("hard-caps verbose meme summaries", () => {
    const summary = Array.from({ length: 20 }, (_, i) => `${i + 1}. meme transfer ${"x".repeat(80)}`).join("\n");
    const compact = compactTelegramSummary("meme 链上监控", summary);
    assert.ok(compact.split("\n").length <= 6);
    assert.ok(compact.length <= 500);
  });

  it("does not truncate other Telegram summaries", () => {
    const summary = "1. macro update\n2. earnings update";
    assert.equal(compactTelegramSummary("传统金融/宏观", summary), summary);
  });
});

describe("isTradeRelevantTweet", () => {
  it("keeps market and regulatory items", () => {
    assert.equal(isTradeRelevantTweet("证监会查实虚假信息扰乱证券市场，股票交易被暂停"), true);
    assert.equal(isTradeRelevantTweet("NVIDIA earnings beat expectations; AI chips revenue rises"), true);
    assert.equal(isTradeRelevantTweet("BTC突破64000美元，过去24小时全网合约爆仓扩大"), true);
  });

  it("filters low-value social noise", () => {
    assert.equal(isTradeRelevantTweet("比利时 4 比 1 击败美国，球员攻入世界杯首球"), false);
    assert.equal(isTradeRelevantTweet("HSBC Pulse卡内地消费返现4.4%，申卡攻略"), false);
    assert.equal(isTradeRelevantTweet("relayrouter.io 提供 Fable 5 账号池七折优惠"), false);
    assert.equal(isTradeRelevantTweet("OKX 推出世界杯竞猜活动，可赢取比特币奖励"), false);
    assert.equal(isTradeRelevantTweet("TradingBox AI 交易信号 7 天免费试用推广"), false);
    assert.equal(isTradeRelevantTweet("Juggling a football for a chance to earn Bitcoin rewards"), false);
    assert.equal(isTradeRelevantTweet("Fable can be used again until July 12th but my quota is gone"), false);
  });
});

describe("compactSummaryFallback", () => {
  it("deduplicates and caps raw text when local agents are unavailable", () => {
    const repeated = [
      "**BTC** breaks 60000",
      "BTC breaks 60000",
      "",
      "[ETH bid](https://example.com)",
      ...Array.from({ length: 30 }, (_, i) => `line ${i}`),
    ].join("\n");
    const out = compactSummaryFallback(repeated);
    assert.match(out, /BTC breaks 60000/);
    assert.match(out, /ETH bid/);
    assert.equal(out.includes("https://example.com"), false);
    assert.ok(out.split("\n").length <= 12);
    assert.ok(out.length <= 1400);
  });
});

describe("chunkTelegramMessage", () => {
  it("splits long brief text into Telegram-sized chunks", () => {
    const chunks = chunkTelegramMessage(["header", "x".repeat(4500)].join("\n\n"));
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.length <= 4000));
  });
});
