import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { openSqliteDb } from "./sqlite-db.js";
import type { TwitterCacheEntry } from "./twitter-cache.js";
import { entryTimestamp } from "./twitter-cache.js";

export const MENTIONS_DB_PATH = join(homedir(), ".onchainos", "strategies", "twitter_mentions.db");

const TICKER_RE = /\$([A-Z]{2,6})\b/g;
const TICKER_BLOCKLIST = new Set([
  "USD", "USDT", "USDC", "EUR", "GBP", "JPY", "CNY", "HKD",
  "WIN", "LOL", "GG", "FOMO", "HODL", "FUD",
  "API", "URL", "CEO", "AI", "ML", "GPT", "LLM", "FYI", "TLDR", "WTF",
  "ETF"
]);

function extractTickers(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(TICKER_RE)) {
    const t = match[1];
    if (t && !TICKER_BLOCKLIST.has(t)) out.add(t);
  }
  return out;
}

function ensureMentionsSchema(db: ReturnType<typeof openSqliteDb>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticker_mentions (
      ticker TEXT NOT NULL,
      tweet_id TEXT NOT NULL,
      author TEXT,
      views INTEGER DEFAULT 0,
      likes INTEGER DEFAULT 0,
      retweets INTEGER DEFAULT 0,
      created_ts REAL NOT NULL,
      text_snippet TEXT,
      PRIMARY KEY (ticker, tweet_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ticker_time ON ticker_mentions(ticker, created_ts);
  `);
}

export function recordTickerMentions(tweets: TwitterCacheEntry[]): number {
  if (!tweets.length) return 0;
  const db = openSqliteDb(MENTIONS_DB_PATH);
  ensureMentionsSchema(db);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO ticker_mentions
    (ticker, tweet_id, author, views, likes, retweets, created_ts, text_snippet)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let rows = 0;
  for (const tweet of tweets) {
    const text = String(tweet.text ?? "");
    const tickers = extractTickers(text);
    if (!tickers.size) continue;
    const ts = entryTimestamp(tweet);
    if (!ts) continue;
    const tweetId = String(tweet.id ?? "");
    if (!tweetId) continue;
    const author = String(tweet.author ?? "");
    const views = Number.parseInt(String(tweet.views ?? 0), 10) || 0;
    const likes = Number.parseInt(String(tweet.likes ?? 0), 10) || 0;
    const retweets = Number.parseInt(String(tweet.retweets ?? 0), 10) || 0;
    const snippet = text.slice(0, 200);
    for (const ticker of tickers) {
      insert.run(ticker, tweetId, author, views, likes, retweets, ts.getTime() / 1000, snippet);
      rows += 1;
    }
  }
  return rows;
}

export function textHash(text: string): string {
  return createHash("md5").update(text.slice(0, 100)).digest("hex").slice(0, 12);
}