import { dotGet, loadTradeConfig, type TradeConfig } from "./config.js";
import { runOpencli } from "./data-helpers.js";
import { formatDisplayTime } from "./time-utils.js";
import { verifyStepTimeoutMs, withVerifyTimeout } from "./verify-signals.js";

const TWITTER_SEARCH_SESSION = "trade-twitter-search";

export type CelebrityVerifyStatus = "ok" | "no-results" | "auth-required" | "challenge" | "unknown" | "error";

export interface CelebritySearchSnapshot {
  title?: string;
  url?: string;
  text?: string;
  articles?: number;
}

export interface CelebrityVerifyResult {
  account: string;
  status: CelebrityVerifyStatus;
  articles: number;
  title: string;
  url: string;
  detail: string;
}

export function celebrityAccountsFromConfig(config: TradeConfig): string[] {
  const cfg = (dotGet(config, "alerts.celebrity_tweet", {}) ?? {}) as Record<string, unknown>;
  return Array.isArray(cfg.accounts) ? cfg.accounts.map(String).filter(Boolean) : [];
}

export function classifyCelebritySearchSnapshot(
  account: string,
  snapshot: CelebritySearchSnapshot
): CelebrityVerifyResult {
  const title = String(snapshot.title ?? "");
  const url = String(snapshot.url ?? "");
  const text = String(snapshot.text ?? "");
  const articles = Number(snapshot.articles ?? 0) || 0;
  const haystack = `${title}\n${url}\n${text}`.toLowerCase();

  if (articles > 0) {
    return { account, status: "ok", articles, title, url, detail: `found ${articles} article(s)` };
  }
  if (/captcha|challenge|unusual activity|automated|verify (that )?you are|confirm you are/i.test(haystack)) {
    return { account, status: "challenge", articles, title, url, detail: "X challenge/captcha likely present" };
  }
  if (/sign in|log in|login|phone, email, or username|password/.test(haystack)) {
    return { account, status: "auth-required", articles, title, url, detail: "X login required" };
  }
  if (haystack.includes(`no results for "from:${account.toLowerCase()}"`) || haystack.includes("no results for")) {
    return { account, status: "no-results", articles, title, url, detail: "search loaded but returned no tweet articles" };
  }
  return { account, status: "unknown", articles, title, url, detail: "search loaded without recognizable articles or no-results marker" };
}

async function inspectCelebrityAccount(account: string, timeoutMs: number): Promise<CelebrityVerifyResult> {
  const url = `https://x.com/search?q=${encodeURIComponent(`from:${account}`)}&f=live`;
  const js = `(() => ({
  title: document.title,
  url: location.href,
  text: document.body.innerText.slice(0, 1600),
  articles: document.querySelectorAll('article').length
}))()`;
  try {
    return await withVerifyTimeout(`celebrity:${account}`, timeoutMs, async () => {
      const opened = await runOpencli(["browser", TWITTER_SEARCH_SESSION, "--window", "background", "open", url], 30_000);
      if (!opened.ok) {
        return { account, status: "error", articles: 0, title: "", url, detail: opened.error ?? "opencli open failed" };
      }
      await runOpencli(["browser", TWITTER_SEARCH_SESSION, "--window", "background", "wait", "time", "5"], 10_000);
      const evalResult = await runOpencli(["browser", TWITTER_SEARCH_SESSION, "--window", "background", "eval", js], 30_000);
      if (!evalResult.ok) {
        return { account, status: "error", articles: 0, title: "", url, detail: evalResult.error ?? "opencli eval failed" };
      }
      const row = evalResult.data.find((item): item is Record<string, unknown> => (
        Boolean(item) && typeof item === "object" && !Array.isArray(item)
      ));
      return classifyCelebritySearchSnapshot(account, row ?? { url });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { account, status: "error", articles: 0, title: "", url, detail: msg };
  }
}

export function formatCelebrityVerifyResults(results: CelebrityVerifyResult[]): string {
  const stamp = formatDisplayTime(new Date(), "hm");
  const lines = [`🧪 名人推文监控验证 — ${stamp}`];
  for (const result of results) {
    const icon = result.status === "ok" || result.status === "no-results" ? "✅" : "❌";
    lines.push(`${icon} @${result.account} ${result.status} — ${result.detail}`);
  }
  const failing = results.filter((result) => !["ok", "no-results"].includes(result.status)).length;
  lines.push("", `summary: ${results.length - failing}/${results.length} readable`);
  return lines.join("\n");
}

export async function runVerifyCelebrity(options: { dryRun?: boolean } = {}): Promise<CelebrityVerifyResult[]> {
  const config = await loadTradeConfig();
  const accounts = celebrityAccountsFromConfig(config);
  const timeoutMs = verifyStepTimeoutMs(config);
  const results: CelebrityVerifyResult[] = [];

  for (const account of accounts) {
    results.push(await inspectCelebrityAccount(account, timeoutMs));
  }

  const output = formatCelebrityVerifyResults(results);
  process.stdout.write(`${output}\n`);
  if (!options.dryRun) {
    process.stderr.write("[verify-celebrity] no Telegram push is sent; this command is browser health only\n");
  }
  if (results.some((result) => !["ok", "no-results"].includes(result.status))) {
    process.exitCode = 1;
  }
  return results;
}
