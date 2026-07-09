import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  celebrityAccountsFromConfig,
  classifyCelebritySearchSnapshot,
  formatCelebrityVerifyResults
} from "../src/trade/verify-celebrity.js";

describe("celebrityAccountsFromConfig", () => {
  it("reads configured celebrity accounts", () => {
    assert.deepEqual(celebrityAccountsFromConfig({
      alerts: { celebrity_tweet: { accounts: ["realDonaldTrump", "elonmusk"] } }
    }), ["realDonaldTrump", "elonmusk"]);
  });
});

describe("classifyCelebritySearchSnapshot", () => {
  it("classifies article and no-results pages as readable", () => {
    assert.equal(classifyCelebritySearchSnapshot("elonmusk", { articles: 2 }).status, "ok");
    assert.equal(
      classifyCelebritySearchSnapshot("dexterry", { text: 'No results for "from:dexterry"' }).status,
      "no-results"
    );
  });

  it("detects login and challenge states", () => {
    assert.equal(classifyCelebritySearchSnapshot("elonmusk", { text: "Sign in to X\nPhone, email, or username" }).status, "auth-required");
    assert.equal(classifyCelebritySearchSnapshot("elonmusk", { text: "Verify you are human to continue" }).status, "challenge");
  });
});

describe("formatCelebrityVerifyResults", () => {
  it("summarizes readable accounts", () => {
    const text = formatCelebrityVerifyResults([
      { account: "a", status: "ok", articles: 1, title: "", url: "", detail: "found 1 article(s)" },
      { account: "b", status: "no-results", articles: 0, title: "", url: "", detail: "search loaded" },
      { account: "c", status: "challenge", articles: 0, title: "", url: "", detail: "challenge" }
    ]);
    assert.match(text, /@a ok/);
    assert.match(text, /@b no-results/);
    assert.match(text, /@c challenge/);
    assert.match(text, /summary: 2\/3 readable/);
  });
});
