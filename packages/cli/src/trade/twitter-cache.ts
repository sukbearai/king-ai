import { readFile } from "node:fs/promises";
import { TRADE_TWITTER_CACHE_PATH } from "../paths.js";
import { formatDisplayShortTime } from "./time-utils.js";

const ID_HEAD_RE = /^\s*\{\s*"id"\s*:/;

export interface TwitterCacheEntry {
  id?: string;
  text?: string;
  author?: string;
  created_at?: string;
  _fetched_at?: string;
  likes?: number | string;
  retweets?: number | string;
  replies?: number | string;
  views?: number | string;
  url?: string;
}

export function defaultTwitterCachePath(): string {
  return TRADE_TWITTER_CACHE_PATH;
}

export async function* iterCacheRecords(path = defaultTwitterCachePath()): AsyncGenerator<TwitterCacheEntry> {
  let lines: string[];
  try {
    lines = (await readFile(path, "utf8")).split("\n");
  } catch {
    return;
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i += 1;
      continue;
    }
    try {
      yield JSON.parse(line) as TwitterCacheEntry;
      i += 1;
      continue;
    } catch {
      // Greedy join broken multi-line records.
    }
    const buf = [line];
    let j = i + 1;
    while (j < lines.length && !ID_HEAD_RE.test(lines[j] ?? "")) {
      buf.push(lines[j] ?? "");
      j += 1;
    }
    const joined = buf.join("\n");
    try {
      yield JSON.parse(joined) as TwitterCacheEntry;
    } catch {
      try {
        yield JSON.parse(joined.replace(/\n/g, "\\n").replace(/\r/g, "\\r")) as TwitterCacheEntry;
      } catch {
        // Unrecoverable record.
      }
    }
    i = j;
  }
}

function parseTweetTime(ts: string): Date | null {
  if (!ts) return null;
  const twitter = Date.parse(ts.replace(/(\+\d{4})\s(\d{4})$/, "$1 $2"));
  if (Number.isFinite(twitter)) return new Date(twitter);
  const iso = Date.parse(ts.replace("Z", "+00:00"));
  if (Number.isFinite(iso)) return new Date(iso);
  const day = Date.parse(`${ts.trim()}T00:00:00Z`);
  return Number.isFinite(day) ? new Date(day) : null;
}

export function entryTimestamp(entry: TwitterCacheEntry): Date | null {
  return parseTweetTime(String(entry.created_at ?? "")) ?? parseTweetTime(String(entry._fetched_at ?? ""));
}

export async function countRecentCacheRecords(
  hours: number,
  path = defaultTwitterCachePath(),
): Promise<{ total: number; recent: number; stale: number; invalid: number }> {
  const cutoff = Date.now() - hours * 3600 * 1000;
  let total = 0;
  let recent = 0;
  let stale = 0;
  let invalid = 0;
  for await (const entry of iterCacheRecords(path)) {
    total += 1;
    const ts = entryTimestamp(entry);
    if (!ts) {
      invalid += 1;
      continue;
    }
    if (ts.getTime() < cutoff) stale += 1;
    else recent += 1;
  }
  return { total, recent, stale, invalid };
}

export function formatTweetLine(entry: TwitterCacheEntry, options: { maxTextChars?: number } = {}): string {
  const author = String(entry.author ?? "");
  const text = String(entry.text ?? "").trim();
  if (!text) return "";
  const textChars = [...text];
  const maxTextChars = options.maxTextChars;
  const displayText =
    maxTextChars !== undefined && maxTextChars > 0 && textChars.length > maxTextChars
      ? `${textChars
          .slice(0, maxTextChars - 1)
          .join("")
          .trimEnd()}…`
      : text;
  const likes = Number.parseInt(String(entry.likes ?? 0), 10) || 0;
  const retweets = Number.parseInt(String(entry.retweets ?? 0), 10) || 0;
  const replies = Number.parseInt(String(entry.replies ?? 0), 10) || 0;
  const views = Number.parseInt(String(entry.views ?? 0), 10) || 0;
  const tid = String(entry.id ?? "");
  const url = String(entry.url ?? "") || (author && tid ? `https://x.com/${author}/status/${tid}` : "");
  const eng: string[] = [];
  if (likes > 0) eng.push(`${likes}❤️`);
  if (retweets > 0) eng.push(`${retweets}🔁`);
  if (replies > 0) eng.push(`${replies}💬`);
  if (views > 0) eng.push(`${views}👁`);
  const engagement = eng.length ? ` [${eng.join("/")}]` : "";
  const urlSuffix = url ? ` ${url}` : "";
  const timestamp = entryTimestamp(entry);
  const timeSuffix = timestamp ? ` [${formatDisplayShortTime(timestamp)}]` : "";
  return `@${author}: ${displayText}${engagement}${timeSuffix}${urlSuffix}`;
}

export function engagementScore(line: string): number {
  const likes = Number.parseInt(line.match(/(\d+)❤️/)?.[1] ?? "0", 10) || 0;
  const retweets = Number.parseInt(line.match(/(\d+)🔁/)?.[1] ?? "0", 10) || 0;
  const replies = Number.parseInt(line.match(/(\d+)💬/)?.[1] ?? "0", 10) || 0;
  const views = Number.parseInt(line.match(/(\d+)👁/)?.[1] ?? "0", 10) || 0;
  return likes + retweets * 2 + replies + Math.floor(views / 1000);
}
