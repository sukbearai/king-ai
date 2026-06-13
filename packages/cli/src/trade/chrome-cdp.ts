/**
 * Chrome DevTools Protocol client for trade data collection.
 * Replaces opencli browser/twitter/xueqiu subprocess calls with a logged-in Chrome session.
 *
 * Start Chrome with remote debugging, e.g.:
 *   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
 *
 * Configure via KING_AI_CHROME_CDP_URL (default http://127.0.0.1:9222).
 */

export interface CdpTarget {
  id: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
}

export interface ChromeCdpDeps {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocketLike;
  sleep?: (ms: number) => Promise<void>;
}

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (ev: EventLike) => void): void;
  removeEventListener?(type: string, listener: (ev: EventLike) => void): void;
}

interface EventLike {
  data?: string;
  message?: string;
}

const DEFAULT_CDP_BASE = "http://127.0.0.1:9222";
const WS_OPEN = 1;

export function chromeCdpBaseUrl(): string {
  const raw = process.env.KING_AI_CHROME_CDP_URL?.trim();
  return raw || DEFAULT_CDP_BASE;
}

export function twitterSearchUrl(query: string): string {
  return `https://x.com/search?q=${encodeURIComponent(query)}&f=live`;
}

export function twitterHomeUrl(timelineType: string): string {
  return timelineType === "following" ? "https://x.com/home" : "https://x.com/home";
}

export function xueqiuStockUrl(symbol: string): string {
  const sym = symbol.trim().toUpperCase();
  if (sym.startsWith("SH") || sym.startsWith("SZ")) {
    return `https://xueqiu.com/S/${sym}`;
  }
  return `https://xueqiu.com/S/${sym}`;
}

export function parseTweetRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parseTweetRows(parsed);
    } catch {
      return [];
    }
  }
  return [];
}

export function parseXueqiuQuote(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const price = Number.parseFloat(String(row.price ?? row.Price ?? row.current ?? ""));
  const changeRaw = row.change_pct ?? row.ChangePercent ?? row.ChangePct ?? row.changePercent ?? row.percent ?? "0";
  const changePct = Number.parseFloat(String(changeRaw).replace(/%/g, "").replace(/\+/g, "").trim());
  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    price,
    change_pct: Number.isFinite(changePct) ? changePct : 0,
    Price: price,
    ChangePercent: Number.isFinite(changePct) ? changePct : 0
  };
}

export const TWEET_SCRAPE_JS = `(function() {
  const out = [];
  const seen = new Set();
  const articles = document.querySelectorAll('article[data-testid="tweet"]');
  for (const article of articles) {
    const textEl = article.querySelector('[data-testid="tweetText"]');
    const text = textEl ? textEl.innerText.trim() : '';
    const link = article.querySelector('a[href*="/status/"]');
    const href = link ? link.getAttribute('href') || '' : '';
    const idMatch = href.match(/status\\/(\\d+)/);
    const id = idMatch ? idMatch[1] : '';
    if (!text && !id) continue;
    const key = id || text.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    const userLink = article.querySelector('a[href^="/"][role="link"]');
    const author = userLink ? (userLink.getAttribute('href') || '').replace(/^\\//, '').split('/')[0] : '';
    const timeEl = article.querySelector('time');
    const created_at = timeEl ? (timeEl.getAttribute('datetime') || timeEl.innerText || '') : '';
    const statGroup = article.querySelector('[role="group"]');
    let likes = 0, retweets = 0, views = 0;
    if (statGroup) {
      for (const btn of statGroup.querySelectorAll('button, a')) {
        const label = (btn.getAttribute('aria-label') || btn.innerText || '').toLowerCase();
        const numMatch = label.match(/(\\d[\\d,\\.]*[kmb]?)/i);
        const raw = numMatch ? numMatch[1] : '0';
        let n = parseFloat(raw.replace(/,/g, '')) || 0;
        if (/k$/i.test(raw)) n *= 1000;
        if (/m$/i.test(raw)) n *= 1000000;
        if (label.includes('like') || label.includes('喜欢')) likes = n;
        else if (label.includes('repost') || label.includes('retweet') || label.includes('转')) retweets = n;
        else if (label.includes('view') || label.includes('浏览')) views = n;
      }
    }
    out.push({
      id,
      text,
      author,
      created_at,
      likes,
      retweets,
      views,
      url: id ? 'https://x.com/i/status/' + id : ''
    });
  }
  return out;
})()`;

export const XUEQIU_SCRAPE_JS = `(function() {
  const body = document.body ? document.body.innerText : '';
  const priceMatch = body.match(/(?:现价|最新|当前价|价格)[^\\d]{0,12}([\\d,]+(?:\\.\\d+)?)/);
  const pctMatch = body.match(/([+\\-]?[\\d,]+(?:\\.\\d+)?)\\s*%/);
  let price = 0;
  let change_pct = 0;
  if (priceMatch) price = parseFloat(priceMatch[1].replace(/,/g, ''));
  const strong = document.querySelector('.stock-current, .symbol-price, [class*="current"]');
  if (strong) {
    const t = strong.textContent || '';
    const m = t.match(/([\\d,]+(?:\\.\\d+)?)/);
    if (m) price = parseFloat(m[1].replace(/,/g, '')) || price;
  }
  if (pctMatch) change_pct = parseFloat(pctMatch[1].replace(/,/g, '').replace(/\\+/g, '')) || 0;
  const changeEl = document.querySelector('[class*="change"], [class*="percent"]');
  if (changeEl) {
    const m = (changeEl.textContent || '').match(/([+\\-]?[\\d,]+(?:\\.\\d+)?)/);
    if (m) change_pct = parseFloat(m[1].replace(/,/g, '').replace(/\\+/g, '')) || change_pct;
  }
  return { price, change_pct, Price: price, ChangePercent: change_pct };
})()`;

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultWebSocketFactory(url: string): Promise<WebSocketLike> {
  if (typeof globalThis.WebSocket !== "function") {
    throw new Error("WebSocket client unavailable; use Node >= 22 or run trade with a runtime that provides global WebSocket");
  }
  return new globalThis.WebSocket(url) as unknown as WebSocketLike;
}

class CdpSession {
  private readonly ws: WebSocketLike;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(ws: WebSocketLike) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : "";
      if (!raw) return;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(raw) as { id?: number; result?: unknown; error?: { message?: string } };
      } catch {
        return;
      }
      if (msg.id == null) return;
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(msg.error.message || "CDP error"));
      else slot.resolve(msg.result);
    });
  }

  static async connect(webSocketDebuggerUrl: string, factory: (url: string) => WebSocketLike | Promise<WebSocketLike>): Promise<CdpSession> {
    const ws = await factory(webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        ws.removeEventListener?.("open", onOpen);
        ws.removeEventListener?.("error", onError);
        resolve();
      };
      const onError = (ev: EventLike): void => {
        ws.removeEventListener?.("open", onOpen);
        ws.removeEventListener?.("error", onError);
        reject(new Error(ev.message || "WebSocket connection failed"));
      };
      if (ws.readyState === WS_OPEN) {
        resolve();
        return;
      }
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
    });
    const session = new CdpSession(ws);
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    return session;
  }

  close(): void {
    this.ws.close();
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 120_000);
    });
  }

  async navigate(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
    await this.send("Runtime.evaluate", {
      expression: "new Promise(r => { if (document.readyState === 'complete') r(); else window.addEventListener('load', () => r(), { once: true }); })",
      awaitPromise: true
    }).catch(() => undefined);
  }

  async evaluate(expression: string, awaitPromise = false): Promise<unknown> {
    const result = (await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true
    })) as { result?: { value?: unknown; type?: string } };
    return result?.result?.value;
  }
}

export async function listCdpTargets(deps: ChromeCdpDeps = {}): Promise<CdpTarget[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const baseUrl = deps.baseUrl ?? chromeCdpBaseUrl();
  try {
    const res = await fetchImpl(`${baseUrl}/json/list`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    return rows
      .filter((row) => typeof row.webSocketDebuggerUrl === "string")
      .map((row) => ({
        id: String(row.id ?? ""),
        url: String(row.url ?? ""),
        title: String(row.title ?? ""),
        webSocketDebuggerUrl: String(row.webSocketDebuggerUrl)
      }));
  } catch {
    return [];
  }
}

async function openCdpTab(url: string, deps: ChromeCdpDeps): Promise<CdpTarget | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const baseUrl = deps.baseUrl ?? chromeCdpBaseUrl();
  try {
    const putUrl = `${baseUrl}/json/new?${new URLSearchParams({ url })}`;
    const res = await fetchImpl(putUrl, { method: "PUT", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const row = (await res.json()) as Record<string, unknown>;
    if (typeof row.webSocketDebuggerUrl !== "string") return null;
    return {
      id: String(row.id ?? ""),
      url: String(row.url ?? url),
      title: String(row.title ?? ""),
      webSocketDebuggerUrl: row.webSocketDebuggerUrl
    };
  } catch {
    return null;
  }
}

async function pickTarget(preferredHost: string, deps: ChromeCdpDeps): Promise<CdpTarget | null> {
  const targets = await listCdpTargets(deps);
  if (preferredHost) {
    const match = targets.find((t) => t.url.includes(preferredHost));
    if (match) return match;
  }
  return targets[0] ?? null;
}

async function withCdpSession<T>(
  pageUrl: string,
  hostHint: string,
  fn: (session: CdpSession) => Promise<T>,
  deps: ChromeCdpDeps = {}
): Promise<T> {
  const sleep = deps.sleep ?? defaultSleep;
  const wsFactory = deps.webSocketFactory ?? defaultWebSocketFactory;
  let target = await pickTarget(hostHint, deps);
  if (!target) {
    target = await openCdpTab(pageUrl, deps);
    if (target) await sleep(2000);
  }
  if (!target) throw new Error(`Chrome CDP unavailable at ${deps.baseUrl ?? chromeCdpBaseUrl()}`);
  const session = await CdpSession.connect(target.webSocketDebuggerUrl, wsFactory);
  try {
    const current = String(await session.evaluate("window.location.href").catch(() => "") ?? "");
    if (!current.includes(hostHint)) {
      await session.navigate(pageUrl);
      await sleep(2500);
    }
    return await fn(session);
  } finally {
    session.close();
  }
}

export interface ChromeBrowserOptions {
  pageUrl?: string;
  hostHint?: string;
}

export async function chromeBrowserEval(
  expression: string,
  options: ChromeBrowserOptions = {},
  deps: ChromeCdpDeps = {}
): Promise<string> {
  const pageUrl = options.pageUrl ?? "about:blank";
  const hostHint = options.hostHint ?? new URL(pageUrl).host;
  try {
    const value = await withCdpSession(pageUrl, hostHint, async (session) => {
      const result = await session.evaluate(expression, expression.includes("Promise") || expression.includes("await"));
      return result;
    }, deps);
    if (typeof value === "string") return value;
    if (value == null) return "";
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

export async function chromeBrowserOpen(url: string, deps: ChromeCdpDeps = {}): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep;
  const host = new URL(url).host;
  await withCdpSession(url, host, async (session) => {
    await session.navigate(url);
    await sleep(1500);
  }, deps);
}

export async function chromeTwitterTimeline(
  options: { limit?: number; type?: string } = {},
  deps: ChromeCdpDeps = {}
): Promise<Array<Record<string, unknown>>> {
  const limit = options.limit ?? 500;
  const type = options.type ?? "following";
  const pageUrl = twitterHomeUrl(type);
  try {
    const rows = await withCdpSession(pageUrl, "x.com", async (session) => {
      await session.evaluate(`window.scrollTo(0, document.body.scrollHeight * 0.5)`).catch(() => undefined);
      const value = await session.evaluate(TWEET_SCRAPE_JS);
      return parseTweetRows(value);
    }, deps);
    return rows.slice(0, limit);
  } catch {
    return [];
  }
}

export async function chromeTwitterSearch(
  options: { query: string; limit?: number },
  deps: ChromeCdpDeps = {}
): Promise<Array<Record<string, unknown>>> {
  const limit = options.limit ?? 20;
  const pageUrl = twitterSearchUrl(options.query);
  try {
    const rows = await withCdpSession(pageUrl, "x.com", async (session) => {
      const value = await session.evaluate(TWEET_SCRAPE_JS);
      return parseTweetRows(value);
    }, deps);
    return rows.slice(0, limit);
  } catch {
    return [];
  }
}

export async function chromeXueqiuStock(symbol: string, deps: ChromeCdpDeps = {}): Promise<Record<string, unknown> | null> {
  const pageUrl = xueqiuStockUrl(symbol);
  try {
    return await withCdpSession(pageUrl, "xueqiu.com", async (session) => {
      const value = await session.evaluate(XUEQIU_SCRAPE_JS);
      return parseXueqiuQuote(value);
    }, deps);
  } catch {
    return null;
  }
}