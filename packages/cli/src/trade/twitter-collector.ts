import { appendFile, readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { dotGet, loadTradeConfig } from "./config.js";
import { runLast30days } from "./data-helpers.js";
import { chromeTwitterTimeline } from "./chrome-cdp.js";
import { recordTickerMentions, textHash } from "./ticker-mentions.js";
import {
  defaultTwitterCachePath,
  entryTimestamp,
  iterCacheRecords,
  type TwitterCacheEntry
} from "./twitter-cache.js";

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
    url: String(lower.url ?? "")
  };
  return tweet.id || tweet.text ? tweet : null;
}

async function fetchTimelineRows(): Promise<TwitterCacheEntry[]> {
  const config = await loadTradeConfig();
  const ds = (dotGet(config, "data_sources.twitter", {}) ?? {}) as Record<string, unknown>;
  const limit = Number(ds.limit) || 500;
  const tlType = String(ds.type ?? "following");

  const rows = await chromeTwitterTimeline({ limit, type: tlType });
  if (rows.length) {
    return rows
      .map((r) => normalizeTweet(r as Record<string, unknown>))
      .filter((t): t is TwitterCacheEntry => t != null);
  }

  const out: TwitterCacheEntry[] = [];
  for (const topic of ["crypto BTC ETH SOL", "meme coin web3", "DeFi yield farming", "NFT web3 alpha"]) {
    const result = await runLast30days(topic, 90_000);
    const ibs = result.items_by_source as Record<string, unknown[]> | undefined;
    const xItems = (ibs?.x ?? result.x ?? []) as Array<Record<string, unknown>>;
    for (const item of xItems) {
      const eng = (item.engagement ?? {}) as Record<string, unknown>;
      const tweet: TwitterCacheEntry = {
        id: String(item.item_id ?? item.url ?? ""),
        text: String(item.body ?? item.text ?? item.title ?? item.snippet ?? ""),
        author: String(item.author ?? item.handle ?? ""),
        created_at: String(item.published_at ?? item.date ?? ""),
        likes: Number(eng.likes ?? 0),
        retweets: Number(eng.reposts ?? 0),
        views: 0,
        url: String(item.url ?? "")
      };
      if (tweet.text) out.push(tweet);
    }
  }
  return out;
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

  process.stderr.write(
    `[twitter-collector] new=${newCount} recent24h=${recent24h} total=${total}\n`
  );
  return { newCount, recent24h, total };
}