import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripAnsi, yahooFinanceQuote } from "../src/trade/data-helpers.js";

describe("stripAnsi", () => {
  it("removes ANSI color codes from surf CLI output", () => {
    const colored = '\x1b[38;5;247m{\x1b[0m\n  \x1b[38;5;74m"data"\x1b[0m: []\n\x1b[38;5;247m}\x1b[0m';
    const plain = stripAnsi(colored);
    assert.equal(plain.includes("\x1b"), false);
    assert.doesNotThrow(() => JSON.parse(plain));
  });

  it("uses Yahoo chartPreviousClose when previousClose is absent", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          chart: {
            result: [
              {
                meta: {
                  regularMarketPrice: 110,
                  chartPreviousClose: 100,
                },
              },
            ],
          },
        }),
      )) as typeof fetch;
    try {
      const quote = await yahooFinanceQuote("AAPL");
      assert.equal(quote.price, 110);
      assert.equal(quote.change_pct, 10);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("prefers chartPreviousClose when Yahoo previousClose is stale", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          chart: {
            result: [
              {
                meta: {
                  regularMarketPrice: 3996.16,
                  previousClose: 3970.75,
                  chartPreviousClose: 4036.59,
                },
              },
            ],
          },
        }),
      )) as typeof fetch;
    try {
      const quote = await yahooFinanceQuote("000001.SS");
      assert.ok(quote.change_pct != null);
      assert.ok(Math.abs(quote.change_pct - -1.0011) < 0.01);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("leaves change_pct undefined when Yahoo has no previous close", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          chart: {
            result: [
              {
                meta: {
                  regularMarketPrice: 110,
                },
              },
            ],
          },
        }),
      )) as typeof fetch;
    try {
      const quote = await yahooFinanceQuote("AAPL");
      assert.equal(quote.price, 110);
      assert.equal(quote.change_pct, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries a transient Yahoo response failure", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response("busy", { status: 503 });
      return new Response(
        JSON.stringify({
          chart: {
            result: [
              {
                meta: {
                  regularMarketPrice: 4.569,
                  chartPreviousClose: 4.529,
                  regularMarketTime: 1783709994,
                },
              },
            ],
          },
        }),
      );
    }) as typeof fetch;
    try {
      const quote = await yahooFinanceQuote("^TNX");
      assert.equal(calls, 2);
      assert.equal(quote.price, 4.569);
      assert.equal(quote.market_time, 1783709994);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
