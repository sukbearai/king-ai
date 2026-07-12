import { appendFile, readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { CliRunResult } from "./cli-result.js";
import { dotGet, loadTradeConfig } from "./config.js";
import { runOpencli } from "./data-helpers.js";
import { recordTickerMentions, textHash } from "./ticker-mentions.js";
import { defaultTwitterCachePath, entryTimestamp, iterCacheRecords, type TwitterCacheEntry } from "./twitter-cache.js";

const TWITTER_BROWSER_SESSION = "trade-twitter";
const TWITTER_HOME_URL = "https://x.com/home";

export interface TwitterCollectorOptions {
  collectLimit: number;
  scrollRounds: number;
  scrollWaitMs: number;
  stagnantRounds: number;
}

export interface TwitterBrowserCollection {
  rows: Array<Record<string, unknown>>;
  rounds: number;
  scanned: number;
  duplicates: number;
}

type OpencliRunner = (args: string[], timeoutMs?: number) => Promise<CliRunResult<unknown[]>>;

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function resolveTwitterCollectorOptions(raw: Record<string, unknown>): TwitterCollectorOptions {
  const collectLimit = boundedInt(raw.collect_limit ?? raw.limit, 120, 10, 500);
  const scrollRounds = boundedInt(raw.scroll_rounds, 10, 1, 30);
  return {
    collectLimit,
    scrollRounds,
    scrollWaitMs: boundedInt(raw.scroll_wait_ms, 800, 100, 5_000),
    stagnantRounds: Math.min(scrollRounds, boundedInt(raw.stagnant_rounds, 2, 1, 10)),
  };
}

export function parseTwitterMetric(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  const normalized = String(value ?? "")
    .trim()
    .replace(/,/g, "");
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*([KMB]|\u4e07|\u4ebf)?/i);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1] ?? "0");
  const suffix = (match[2] ?? "").toUpperCase();
  const multiplier =
    suffix === "K"
      ? 1_000
      : suffix === "M"
        ? 1_000_000
        : suffix === "B"
          ? 1_000_000_000
          : suffix === "\u4e07"
            ? 10_000
            : suffix === "\u4ebf"
              ? 100_000_000
              : 1;
  return Number.isFinite(amount) ? Math.round(amount * multiplier) : 0;
}

export function normalizeTweet(row: Record<string, unknown>): TwitterCacheEntry | null {
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) lower[k.toLowerCase()] = v;
  const tweet: TwitterCacheEntry = {
    id: String(lower.id ?? lower.tweet_id ?? ""),
    text: String(lower.text ?? lower.content ?? ""),
    author: String(lower.author ?? lower.user ?? lower.screen_name ?? ""),
    created_at: String(lower.created_at ?? lower.date ?? lower.time ?? ""),
    likes: parseTwitterMetric(lower.likes ?? lower.favorite_count),
    retweets: parseTwitterMetric(lower.retweets ?? lower.retweet_count),
    replies: parseTwitterMetric(lower.replies ?? lower.reply_count),
    views: parseTwitterMetric(lower.views ?? lower.view_count),
    url: String(lower.url ?? ""),
  };
  return tweet.id || tweet.text ? tweet : null;
}

function timelineSnapshotScript(): string {
  return `(function() {
  const out = [];
  const seen = new Set();
  const articles = Array.from(document.querySelectorAll('article'));
  const metric = (article, selector) => {
    const el = article.querySelector(selector);
    return el ? (el.getAttribute('aria-label') || el.innerText || el.textContent || '') : '';
  };
  for (const article of articles) {
    const textEl = article.querySelector('[data-testid="tweetText"]') || article;
    const text = textEl ? textEl.innerText.trim() : '';
    const link = article.querySelector('a[href*="/status/"]');
    const href = link ? (link.getAttribute('href') || '') : '';
    const idMatch = href.match(/status\\/(\\d+)/);
    const id = idMatch ? idMatch[1] : '';
    if (!text && !id) continue;
    const key = id || text.slice(0, 100);
    if (seen.has(key)) continue;
    seen.add(key);
    const userLink = article.querySelector('[data-testid="User-Name"] a[href^="/"]') || article.querySelector('a[href^="/"][role="link"]');
    const author = userLink ? (userLink.getAttribute('href') || '').replace(/^\\//, '').split('/')[0] : '';
    const timeEl = article.querySelector('time');
    out.push({
      id,
      text,
      author,
      created_at: timeEl ? (timeEl.getAttribute('datetime') || timeEl.innerText || '') : '',
      replies: metric(article, '[data-testid="reply"]'),
      retweets: metric(article, '[data-testid="retweet"], [data-testid="unretweet"]'),
      likes: metric(article, '[data-testid="like"], [data-testid="unlike"]'),
      views: metric(article, 'a[href*="/analytics"]'),
      url: id ? 'https://x.com/i/status/' + id : (href ? new URL(href, location.origin).href : '')
    });
  }
  const lastArticle = articles[articles.length - 1];
  if (lastArticle) lastArticle.scrollIntoView({ block: 'end' });
  window.scrollBy(0, Math.max(window.innerHeight, 800));
  return { rows: out, scanned: articles.length };
})()`;
}

function rowKey(row: Record<string, unknown>): string {
  const normalized = normalizeTweet(row);
  if (!normalized) return "";
  const id = String(normalized.id ?? "");
  if (id) return `id:${id}`;
  const text = String(normalized.text ?? "").slice(0, 100);
  return text ? `text:${textHash(text)}` : "";
}

function parseTimelineSnapshot(data: unknown[]): { rows: Array<Record<string, unknown>>; scanned: number } | null {
  const snapshot = data.find(
    (value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value),
  );
  if (!snapshot || !Array.isArray(snapshot.rows)) return null;
  const rows = snapshot.rows.filter(
    (value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value),
  );
  return { rows, scanned: Number(snapshot.scanned) || rows.length };
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function fetchOpencliBrowserTweets(
  options: TwitterCollectorOptions,
  runner: OpencliRunner = runOpencli,
  wait: (ms: number) => Promise<void> = pause,
): Promise<TwitterBrowserCollection> {
  let lastResult: TwitterBrowserCollection = { rows: [], rounds: 0, scanned: 0, duplicates: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    await runner(["browser", TWITTER_BROWSER_SESSION, "close"], 10_000);
    const opened = await runner(
      ["browser", TWITTER_BROWSER_SESSION, "--window", "background", "open", TWITTER_HOME_URL],
      30_000,
    );
    if (!opened.ok) continue;
    await runner(["browser", TWITTER_BROWSER_SESSION, "--window", "background", "wait", "time", "5"], 10_000);
    const ready = await runner(
      [
        "browser",
        TWITTER_BROWSER_SESSION,
        "--window",
        "background",
        "wait",
        "selector",
        "article",
        "--timeout",
        "30000",
      ],
      35_000,
    );
    if (!ready.ok) continue;

    const rows = new Map<string, Record<string, unknown>>();
    let scanned = 0;
    let duplicates = 0;
    let stagnant = 0;
    let rounds = 0;
    let evalFailed = false;
    for (let round = 0; round < options.scrollRounds; round++) {
      const evalResult = await runner(
        ["browser", TWITTER_BROWSER_SESSION, "--window", "background", "eval", timelineSnapshotScript()],
        30_000,
      );
      if (!evalResult.ok) {
        evalFailed = true;
        break;
      }
      const snapshot = parseTimelineSnapshot(evalResult.data);
      if (!snapshot) {
        evalFailed = true;
        break;
      }
      rounds += 1;
      scanned += snapshot.scanned;
      let added = 0;
      for (const row of snapshot.rows) {
        const key = rowKey(row);
        if (!key) continue;
        if (rows.has(key)) {
          duplicates += 1;
          continue;
        }
        rows.set(key, row);
        added += 1;
        if (rows.size >= options.collectLimit) break;
      }
      stagnant = added === 0 ? stagnant + 1 : 0;
      lastResult = { rows: [...rows.values()], rounds, scanned, duplicates };
      if (rows.size >= options.collectLimit || stagnant >= options.stagnantRounds) break;
      await wait(options.scrollWaitMs * (added === 0 ? 2 : 1));
    }
    if (lastResult.rows.length) return lastResult;
    if (!evalFailed && attempt === 1) return lastResult;
  }
  return lastResult;
}

async function fetchTimelineRows(): Promise<{ tweets: TwitterCacheEntry[]; browser: TwitterBrowserCollection }> {
  const config = await loadTradeConfig();
  const ds = (dotGet(config, "data_sources.twitter", {}) ?? {}) as Record<string, unknown>;
  const options = resolveTwitterCollectorOptions(ds);

  const browser = await fetchOpencliBrowserTweets(options);
  const tweets = browser.rows.map(normalizeTweet).filter((tweet): tweet is TwitterCacheEntry => tweet != null);
  return { tweets, browser };
}

async function loadDedupSets(cachePath: string): Promise<{ ids: Set<string>; hashes: Set<string> }> {
  const ids = new Set<string>();
  const hashes = new Set<string>();
  for await (const entry of iterCacheRecords(cachePath)) {
    const id = String(entry.id ?? "");
    if (id) ids.add(id);
    const txt = String(entry.text ?? "").slice(0, 100);
    if (txt) hashes.add(textHash(txt));
  }
  return { ids, hashes };
}

export async function cleanOldTwitterCache(hours: number, cachePath = defaultTwitterCachePath()): Promise<number> {
  let content: string;
  try {
    content = await readFile(cachePath, "utf8");
  } catch {
    return 0;
  }
  const cutoff = Date.now() - hours * 3600 * 1000;
  const kept: string[] = [];
  let removed = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as TwitterCacheEntry;
      const ts = entryTimestamp(entry);
      if (ts && ts.getTime() >= cutoff) kept.push(line);
      else removed += 1;
    } catch {
      kept.push(line);
    }
  }
  await writeFile(cachePath, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
  return removed;
}

export async function runTwitterCollector(cachePath = defaultTwitterCachePath()): Promise<{
  newCount: number;
  recent24h: number;
  total: number;
  authors24h: number;
  rounds: number;
  scanned: number;
  unique: number;
  duplicates: number;
}> {
  await mkdir(dirname(cachePath), { recursive: true });
  const { tweets, browser } = await fetchTimelineRows();
  const { ids, hashes } = await loadDedupSets(cachePath);
  const newTweets: TwitterCacheEntry[] = [];
  let newCount = 0;
  let cacheDuplicates = 0;

  for (const tweet of tweets) {
    const tid = String(tweet.id ?? "");
    const txt = String(tweet.text ?? "").slice(0, 100);
    const hash = txt ? textHash(txt) : "";
    if ((hash && hashes.has(hash)) || (tid && ids.has(tid))) {
      cacheDuplicates += 1;
      continue;
    }
    tweet._fetched_at = new Date().toISOString();
    await appendFile(cachePath, `${JSON.stringify(tweet)}\n`, "utf8");
    if (tid) ids.add(tid);
    if (hash) hashes.add(hash);
    newTweets.push(tweet);
    newCount += 1;
  }

  if (newCount > 0) {
    const mentionRows = recordTickerMentions(newTweets);
    if (mentionRows) process.stderr.write(`[twitter-collector] ticker mentions +${mentionRows}\n`);
  }
  const removed = await cleanOldTwitterCache(48, cachePath);
  if (removed) process.stderr.write(`[twitter-collector] cleaned ${removed} old tweets\n`);

  let recent24h = 0;
  let total = 0;
  const recentAuthors = new Set<string>();
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for await (const entry of iterCacheRecords(cachePath)) {
    total += 1;
    const ts = entryTimestamp(entry);
    if (ts && ts.getTime() >= cutoff) {
      recent24h += 1;
      const author = String(entry.author ?? "").toLowerCase();
      if (author) recentAuthors.add(author);
    }
  }

  const duplicates = browser.duplicates + cacheDuplicates;
  process.stderr.write(
    `[twitter-collector] rounds=${browser.rounds} scanned=${browser.scanned} unique=${tweets.length} duplicates=${duplicates} new=${newCount} recent24h=${recent24h} authors24h=${recentAuthors.size} total=${total}\n`,
  );
  return {
    newCount,
    recent24h,
    total,
    authors24h: recentAuthors.size,
    rounds: browser.rounds,
    scanned: browser.scanned,
    unique: tweets.length,
    duplicates,
  };
}
