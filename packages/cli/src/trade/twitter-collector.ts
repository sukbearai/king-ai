import { appendFile, readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { dotGet, loadTradeConfig } from "./config.js";
import { runOpencli } from "./data-helpers.js";
import { recordTickerMentions, textHash } from "./ticker-mentions.js";
import { defaultTwitterCachePath, entryTimestamp, iterCacheRecords, type TwitterCacheEntry } from "./twitter-cache.js";

const TWITTER_BROWSER_SESSION = "trade-twitter";

function normalizeTweet(row: Record<string, unknown>): TwitterCacheEntry | null {
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) lower[k.toLowerCase()] = v;
  const tweet: TwitterCacheEntry = {
    id: String(lower.id ?? lower.tweet_id ?? ""),
    text: String(lower.text ?? lower.content ?? ""),
    author: String(lower.author ?? lower.user ?? lower.screen_name ?? ""),
    created_at: String(lower.created_at ?? lower.date ?? lower.time ?? ""),
    likes: Number(lower.likes ?? lower.favorite_count ?? 0),
    retweets: Number(lower.retweets ?? lower.retweet_count ?? 0),
    views: Number(lower.views ?? lower.view_count ?? 0),
    url: String(lower.url ?? ""),
  };
  return tweet.id || tweet.text ? tweet : null;
}

async function fetchOpencliBrowserTweets(limit: number): Promise<Array<Record<string, unknown>>> {
  const js = `(function() {
  const out = [];
  const seen = new Set();
  window.scrollTo(0, document.body.scrollHeight * 0.4);
  for (const article of document.querySelectorAll('article')) {
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
    const userLink = article.querySelector('a[href^="/"][role="link"]');
    const author = userLink ? (userLink.getAttribute('href') || '').replace(/^\\//, '').split('/')[0] : '';
    const timeEl = article.querySelector('time');
    out.push({
      id,
      text,
      author,
      created_at: timeEl ? (timeEl.getAttribute('datetime') || timeEl.innerText || '') : '',
      likes: 0,
      retweets: 0,
      views: 0,
      url: id ? 'https://x.com/i/status/' + id : (href ? new URL(href, location.origin).href : '')
    });
    if (out.length >= ${Math.max(1, Math.min(limit, 100))}) break;
  }
  return out;
})()`;
  for (let attempt = 0; attempt < 3; attempt++) {
    await runOpencli(["browser", TWITTER_BROWSER_SESSION, "close"], 10_000);
    await runOpencli(
      ["browser", TWITTER_BROWSER_SESSION, "--window", "background", "open", "https://x.com/home"],
      30_000,
    );
    await runOpencli(["browser", TWITTER_BROWSER_SESSION, "--window", "background", "wait", "time", "5"], 10_000);
    await runOpencli(
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
    const evalResult = await runOpencli(
      ["browser", TWITTER_BROWSER_SESSION, "--window", "background", "eval", js],
      30_000,
    );
    if (!evalResult.ok) continue;
    const rows = evalResult.data.filter(
      (row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row),
    );
    if (rows.length) return rows;
  }
  return [];
}

async function fetchTimelineRows(): Promise<TwitterCacheEntry[]> {
  const config = await loadTradeConfig();
  const ds = (dotGet(config, "data_sources.twitter", {}) ?? {}) as Record<string, unknown>;
  const limit = Number(ds.limit) || 500;

  const rows = await fetchOpencliBrowserTweets(limit);
  return rows.map((r) => normalizeTweet(r as Record<string, unknown>)).filter((t): t is TwitterCacheEntry => t != null);
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
}> {
  await mkdir(dirname(cachePath), { recursive: true });
  const tweets = await fetchTimelineRows();
  const { ids, hashes } = await loadDedupSets(cachePath);
  const newTweets: TwitterCacheEntry[] = [];
  let newCount = 0;

  for (const tweet of tweets) {
    const tid = String(tweet.id ?? "");
    const txt = String(tweet.text ?? "").slice(0, 100);
    const hash = txt ? textHash(txt) : "";
    if (hash && hashes.has(hash)) continue;
    if (tid && ids.has(tid)) continue;
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
    const removed = await cleanOldTwitterCache(48, cachePath);
    if (removed) process.stderr.write(`[twitter-collector] cleaned ${removed} old tweets\n`);
  }

  let recent24h = 0;
  let total = 0;
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for await (const entry of iterCacheRecords(cachePath)) {
    total += 1;
    const ts = entryTimestamp(entry);
    if (ts && ts.getTime() >= cutoff) recent24h += 1;
  }

  process.stderr.write(`[twitter-collector] new=${newCount} recent24h=${recent24h} total=${total}\n`);
  return { newCount, recent24h, total };
}
