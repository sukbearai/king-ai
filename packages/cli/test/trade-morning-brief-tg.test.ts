import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSummaryPrompt, compactSummaryFallback } from "../src/trade/llm-summarize.js";
import {
  buildTwitterQuickList,
  compactTelegramSummary,
  expandChainFmReferences,
  extractChainFmReferences,
  formatChangePct,
  formatMemeAddressIndex,
  formatTwitterSourceNotes,
  marketRegimeLabel,
  parseTelegramChannels,
  parseTgRecentMessages,
  preprocessTelegramBody,
  formatTwitterSummaryHeading,
  isTradeRelevantTweet,
  pickTwitterDisplayTweets,
  rankTwitterCandidates,
  resolveBriefingPushTg,
  shouldGenerateDailySummary,
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

describe("formatChangePct", () => {
  it("adds an explicit sign for positive, negative, and zero changes", () => {
    assert.equal(formatChangePct(0.74), "+0.7%");
    assert.equal(formatChangePct(-0.74), "-0.7%");
    assert.equal(formatChangePct(0), "+0.0%");
  });
});

describe("daily summary helpers", () => {
  it("maps market regimes to Chinese labels", () => {
    assert.equal(marketRegimeLabel("risk_on"), "风险偏好");
    assert.equal(marketRegimeLabel("risk_off"), "避险");
    assert.equal(marketRegimeLabel("neutral"), "中性");
    assert.equal(marketRegimeLabel("volatile"), "高波动");
  });

  it("requires both LLM gates and at least two successful sections", () => {
    const parts = ["title", "section one", "", "[twitter] 获取失败", "section two", ""];
    assert.equal(shouldGenerateDailySummary({}, parts), true);
    assert.equal(shouldGenerateDailySummary({ briefing: { daily_summary: false } }, parts), false);
    assert.equal(shouldGenerateDailySummary({ briefing: { llm_summarize: false } }, parts), false);
    assert.equal(shouldGenerateDailySummary({}, ["title", "section one", "", "[twitter] 获取失败"]), false);
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

  it("preserves complete chain.fm contracts and abbreviated wallet targets when expanded", () => {
    const raw =
      "[盘古斧](https://chain.fm/token/bsc/0xee668b7b056bd3bcf5d6fbb2d83fd5fea0247777) from " +
      "[0xb2...0d05](https://chain.fm/account/bsc/0xb2cec332ac326a8e900fa34c1f14bc2faa120d05)";
    const out = preprocessTelegramBody(expandChainFmReferences(raw));
    assert.match(out, /盘古斧（BSC 合约 0xee668b7b056bd3bcf5d6fbb2d83fd5fea0247777）/);
    assert.match(out, /0xb2\.\.\.0d05（BSC 完整地址 0xb2cec332ac326a8e900fa34c1f14bc2faa120d05）/);
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
  it("reports how many filtered tweets were actually analyzed", () => {
    assert.equal(
      formatTwitterSummaryHeading(24, { cached: 60, filtered: 42, analyzed: 42 }),
      "🐦 Twitter 时间线（最近 24h，缓存 60 条，筛后 42 条，已分析 42 条）\n",
    );
    assert.equal(
      formatTwitterSummaryHeading(24, { cached: 0, filtered: 0, analyzed: 0 }),
      "🐦 Twitter 时间线（最近 24h，缓存 0 条，筛后 0 条，已分析 0 条）\n",
    );
  });

  it("keeps the legacy heading shape when count is unknown", () => {
    assert.equal(formatTwitterSummaryHeading(24), "🐦 Twitter 时间线（最近 24h）\n");
  });

  it("reports displayed tweets when LLM summarization is disabled", () => {
    assert.equal(
      formatTwitterSummaryHeading(24, { cached: 60, filtered: 17, analyzed: 12 }, false),
      "🐦 Twitter 时间线（最近 24h，缓存 60 条，筛后 17 条，展示 12 条高相关推文）\n",
    );
  });
});

describe("Twitter candidate selection", () => {
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

  it("only applies the per-author cap to direct display mode", () => {
    const tweets = [
      { entry: { id: "1" }, formatted: "@alice: first" },
      { entry: { id: "2" }, formatted: "@alice: second" },
      { entry: { id: "3" }, formatted: "@bob: third" },
    ];
    assert.deepEqual(
      pickTwitterDisplayTweets(tweets, 10, 1).map((candidate) => candidate.entry.id),
      ["1", "3"],
    );
  });
});

describe("buildTwitterQuickList", () => {
  const longText = "x".repeat(180);
  const tweets = [
    {
      entry: {
        author: "alice",
        text: longText,
        likes: 100,
        url: "https://x.com/alice/status/1",
      },
      formatted: `@alice: ${longText} [100❤️] https://x.com/alice/status/1`,
    },
    {
      entry: { author: "bob", text: "second", likes: 50, url: "https://x.com/bob/status/2" },
      formatted: "@bob: second [50❤️] https://x.com/bob/status/2",
    },
    {
      entry: { author: "carol", text: "third", likes: 25, url: "https://x.com/carol/status/3" },
      formatted: "@carol: third [25❤️] https://x.com/carol/status/3",
    },
  ];

  it("returns no lines when disabled", () => {
    assert.deepEqual(buildTwitterQuickList(tweets, 0), []);
  });

  it("preserves top-N order and truncates text without losing suffixes", () => {
    const lines = buildTwitterQuickList(tweets, 2);
    assert.equal(lines[0], "⚡ 高互动推文速览（Top 2，按互动排序）");
    assert.match(lines[1] ?? "", /^ {2}@alice: x{139}… \[100❤️\]/);
    assert.match(lines[1] ?? "", /https:\/\/x\.com\/alice\/status\/1$/);
    assert.equal(lines[2], "  @bob: second [50❤️] https://x.com/bob/status/2");
  });
});

describe("Twitter summary input", () => {
  it("can pass the complete filtered timeline without the generic 12000-character cap", () => {
    const marker = "LAST_FILTERED_TWEET";
    const input = `${"x".repeat(13_000)}${marker}`;
    assert.equal(buildSummaryPrompt(input, "Twitter", undefined).includes(marker), false);
    assert.equal(buildSummaryPrompt(input, "Twitter", undefined, null).includes(marker), true);
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

describe("formatMemeAddressIndex", () => {
  it("adds complete contracts and cited abbreviated wallets from chain.fm links", () => {
    const raw =
      "[盘古斧](https://chain.fm/token/bsc/0xee668b7b056bd3bcf5d6fbb2d83fd5fea0247777) from " +
      "[0xb2...0d05](https://chain.fm/account/bsc/0xb2cec332ac326a8e900fa34c1f14bc2faa120d05)";
    const references = extractChainFmReferences(raw);
    assert.equal(references.length, 2);
    assert.equal(
      formatMemeAddressIndex("1. 盘古斧由 0xb2...0d05 转入", references),
      [
        "合约/地址索引：",
        "盘古斧 · BSC 合约 · 0xee668b7b056bd3bcf5d6fbb2d83fd5fea0247777",
        "0xb2...0d05 · BSC 完整地址 · 0xb2cec332ac326a8e900fa34c1f14bc2faa120d05",
      ].join("\n"),
    );
  });

  it("drops numeric labels while keeping meaningful Latin and CJK labels", () => {
    const references = [
      { kind: "token" as const, label: "1", chain: "bsc", address: "0x1" },
      { kind: "token" as const, label: "9", chain: "bsc", address: "0x9" },
      { kind: "token" as const, label: "CZ", chain: "bsc", address: "0xcz" },
      { kind: "token" as const, label: "金钱自由", chain: "bsc", address: "0xfreedom" },
      { kind: "token" as const, label: "$10 billion", chain: "bsc", address: "0xbillion" },
    ];
    const index = formatMemeAddressIndex("1. 9亿资金与1800万成交；CZ、金钱自由、$10 billion 均有异动", references);
    assert.doesNotMatch(index, /^1 ·/m);
    assert.doesNotMatch(index, /^9 ·/m);
    assert.match(index, /^CZ · BSC 合约 · 0xcz$/m);
    assert.match(index, /^金钱自由 · BSC 合约 · 0xfreedom$/m);
    assert.match(index, /^\$10 billion · BSC 合约 · 0xbillion$/m);
  });
});

describe("isTradeRelevantTweet", () => {
  it("keeps market and regulatory items", () => {
    assert.equal(isTradeRelevantTweet("证监会查实虚假信息扰乱证券市场，股票交易被暂停"), true);
    assert.equal(isTradeRelevantTweet("NVIDIA earnings beat expectations; AI chips revenue rises"), true);
    assert.equal(isTradeRelevantTweet("BTC突破64000美元，过去24小时全网合约爆仓扩大"), true);
  });

  it("matches ticker shapes case-sensitively", () => {
    assert.equal(isTradeRelevantTweet("TSLA calls printing after the delivery beat"), true);
    assert.equal(isTradeRelevantTweet("$geo breaking out on prison contract news"), true);
    assert.equal(isTradeRelevantTweet("Join the group to get early access!"), false);
    assert.equal(isTradeRelevantTweet("The danger of acting like a third country is becoming one."), false);
    assert.equal(isTradeRelevantTweet("BRAZIL WINS IN HOUSTON AND IS ON TO THE ROUND OF 16"), false);
  });

  it("filters low-value social noise", () => {
    assert.equal(isTradeRelevantTweet("比利时 4 比 1 击败美国，球员攻入世界杯首球"), false);
    assert.equal(isTradeRelevantTweet("Éderson and his story: from holidays to the World Cup. Behind his choice"), false);
    assert.equal(isTradeRelevantTweet("PGL Major Singapore 2026 Tickets are on SALE! $1.25M prize pool, 32 teams"), false);
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
