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
