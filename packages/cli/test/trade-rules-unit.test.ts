import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { directionLabel, createAlert } from "../src/trade/alert-rule.js";
import { parseMemeTradeAmount } from "../src/trade/rules/rule-e-meme.js";
import {
  celebrityAlertSeverity,
  extractChainFmRefs,
  isLikelyTweetUiFragment
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
    assert.equal(directionLabel(createAlert({
      rule: "x", severity: "info", title: "t", detail: "d", direction: -1
    })), "跌破");
    assert.equal(directionLabel(createAlert({
      rule: "x", severity: "info", title: "t", detail: "d", direction: 1
    })), "突破");
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

  it("maps alpha type and entity count to severity", () => {
    assert.equal(celebrityAlertSeverity("endorsement", 1), "warning");
    assert.equal(celebrityAlertSeverity("naming", 3), "warning");
    assert.equal(celebrityAlertSeverity("naming", 1), "info");
  });

  it("filters browser UI fragments before LLM extraction", () => {
    assert.equal(isLikelyTweetUiFragment(`Donald J. Trump
@realDonaldTrump
·
May 23
0:20
72K
112K
909K
99M`, "realDonaldTrump"), true);
    assert.equal(isLikelyTweetUiFragment("Launching a new token today on Solana", "realDonaldTrump"), false);
  });
});

describe("slim registry", () => {
  it("loads every listed rule id", () => {
    for (const id of listRuleIds()) {
      assert.ok(createRule(id), `slim rule ${id}`);
    }
  });
});
