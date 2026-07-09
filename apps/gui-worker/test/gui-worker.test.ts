/// <reference types="@cloudflare/workers-types" />

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import worker, {
  GuiState,
  isGroupRollCallMessage,
  isGroupSequentialCountMessage,
  isLightweightCoordinationMessage,
  isPlannerGuidanceMessage,
  resolveWakeEvent,
  resolveWakeData,
  shouldAutoDelegateMessage,
  triageResponseMode,
  wakeEventVisibleToAgent,
  wakeResolveContextFromState,
  shouldSuppressAgentWake,
  isMessageInboxSettled,
  agentReplyForMessage,
  applyAgentReadUpTo,
  settleTaskInboxForAgents,
} from "../src/index.js";
import { createFakeSql } from "./fake-sql.js";

type StorageMap = Map<string, unknown>;

class FakeStorage {
  private readonly putCounts = new Map<string, number>();

  constructor(
    private readonly map: StorageMap,
    private readonly failPutAfter = new Map<string, number>(),
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    if (value === undefined) throw new TypeError("put() called with undefined value.");
    const count = (this.putCounts.get(key) ?? 0) + 1;
    this.putCounts.set(key, count);
    const failAfter = this.failPutAfter.get(key);
    if (failAfter !== undefined && count > failAfter) throw new Error(`put failed: ${key}`);
    this.map.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
}

function env(
  initialState?: unknown,
  extraBindings: Record<string, unknown> = {},
): { GUI_STATE: DurableObjectNamespace } & Record<string, unknown> {
  const instances = new Map<string, DurableObjectStub>();
  const failPutAfter = new Map<string, number>();
  const rawFailPutAfter = extraBindings.KING_AI_TEST_FAIL_STORAGE_PUT_AFTER;
  if (rawFailPutAfter && typeof rawFailPutAfter === "object") {
    for (const [key, value] of Object.entries(rawFailPutAfter)) {
      if (typeof key === "string" && typeof value === "number") failPutAfter.set(key, value);
    }
  }
  const createStub = (name: string) => {
    const storage: StorageMap = new Map();
    if (initialState && name === "global") storage.set("state:base", initialState);
    const storageWithSql = Object.assign(new FakeStorage(storage, failPutAfter), { sql: createFakeSql() });
    const state = { storage: storageWithSql } as unknown as DurableObjectState;
    const instance = new GuiState(state);
    return {
      fetch: (input: string | URL | Request, init?: RequestInit) => instance.fetch(new Request(input, init)),
    } as DurableObjectStub;
  };
  return {
    GUI_STATE: {
      idFromName: (name: string) => name,
      get: (id: unknown) => {
        const name = typeof id === "string" ? id : "global";
        let stub = instances.get(name);
        if (!stub) {
          stub = createStub(name);
          instances.set(name, stub);
        }
        return stub;
      },
    } as unknown as DurableObjectNamespace,
    ...extraBindings,
  };
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) assert.fail(await res.text());
  return (await res.json()) as T;
}

async function pairComputer(
  bindings: { GUI_STATE: DurableObjectNamespace },
  payload: { engines?: string[]; capabilities?: { workspaces?: string[]; agentWorkspaceRoot?: string } } = {},
): Promise<{ computerId: string; deviceToken: string }> {
  const summary = await json<{ pairingCode: string; tenantId?: string }>(
    await worker.fetch(new Request("https://gui/gui/summary"), bindings),
  );
  return json<{ computerId: string; deviceToken: string; tenantId?: string }>(
    await worker.fetch(
      new Request("https://gui/api/computers/pair", {
        method: "POST",
        body: JSON.stringify({ code: summary.pairingCode, ...payload }),
      }),
      bindings,
    ),
  );
}

function wordCards(tokens: string[]): string {
  return `WordCards: ${JSON.stringify({
    cards: tokens.map((token) => ({
      token,
      lemma: token,
      meaningZh: `${token} 的中文义`,
      phonetic: `/${token.toLowerCase()}/`,
      syllables: [token],
    })),
  })}`;
}

function structuredWordCards(
  sentences: Array<{ text: string; clauses: Array<{ text: string; core: string; phrases?: string[] }> }>,
  tokens: string[],
): string {
  return `WordCards: ${JSON.stringify({
    sentences,
    cards: tokens.map((token) => ({
      token,
      lemma: token,
      meaningZh: `${token} 的中文义`,
      phonetic: `/${token.toLowerCase()}/`,
      syllables: [token],
    })),
  })}`;
}

function cardJson(
  token: string,
  overrides: Partial<{
    lemma: string;
    meaningZh: string;
    phonetic: string;
    syllables: string[];
    partOfSpeech: string;
    roots: string;
  }> = {},
): {
  token: string;
  lemma: string;
  meaningZh: string;
  phonetic: string;
  syllables: string[];
  partOfSpeech?: string;
  roots?: string;
} {
  return {
    token,
    lemma: overrides.lemma ?? token,
    meaningZh: overrides.meaningZh ?? `${token} 的中文义`,
    phonetic: overrides.phonetic ?? `/${token.toLowerCase()}/`,
    syllables: overrides.syllables ?? [token],
    ...(overrides.partOfSpeech === undefined ? {} : { partOfSpeech: overrides.partOfSpeech }),
    ...(overrides.roots === undefined ? {} : { roots: overrides.roots }),
  };
}

test("gui runtime isolates state by tenant identity", async () => {
  const bindings = env();
  const aliceHeaders = { "Cf-Access-Authenticated-User-Email": "alice@example.com" };
  const bobHeaders = { "Cf-Access-Authenticated-User-Email": "bob@example.com" };
  const aliceSummary = await json<{
    pairingCode: string;
    pairingLocator: string;
    tenantId: string;
    pairCommandTenantArg: string;
  }>(await worker.fetch(new Request("https://gui/gui/summary", { headers: aliceHeaders }), bindings));
  const bobSummary = await json<{
    pairingCode: string;
    pairingLocator: string;
    tenantId: string;
    pairCommandTenantArg: string;
  }>(await worker.fetch(new Request("https://gui/gui/summary", { headers: bobHeaders }), bindings));
  assert.equal(aliceSummary.tenantId, "user-alice-example.com");
  assert.equal(bobSummary.tenantId, "user-bob-example.com");
  assert.notEqual(aliceSummary.pairingCode, bobSummary.pairingCode);
  assert.match(aliceSummary.pairingCode, /^user-alice-example\.com:/);
  assert.match(aliceSummary.pairingLocator, /^king-ai:\/\/pair\?/);
  assert.match(aliceSummary.pairingLocator, /server=https%3A%2F%2Fgui/);
  assert.match(aliceSummary.pairingLocator, /tenant=user-alice-example.com/);
  assert.equal(aliceSummary.pairCommandTenantArg, "");

  const alicePaired = await json<{ deviceToken: string; tenantId: string }>(
    await worker.fetch(
      new Request("https://gui/api/computers/pair", {
        method: "POST",
        body: JSON.stringify({ code: aliceSummary.pairingCode, engines: ["codex"] }),
      }),
      bindings,
    ),
  );
  assert.equal(alicePaired.tenantId, aliceSummary.tenantId);
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      headers: aliceHeaders,
      body: JSON.stringify({ body: "alice only" }),
    }),
    bindings,
  );

  const aliceToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${alicePaired.deviceToken}`, "X-King-AI-Tenant": aliceSummary.tenantId },
      }),
      bindings,
    ),
  );
  const aliceInbox = await json<{ rows: { body: string }[] }>(
    await worker.fetch(
      new Request("https://gui/runtime/inbox", {
        headers: { Authorization: `Bearer ${aliceToken.token}`, "X-King-AI-Tenant": aliceSummary.tenantId },
      }),
      bindings,
    ),
  );
  assert.equal(aliceInbox.rows[0]?.body, "alice only");

  const crossTenantToken = await worker.fetch(
    new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${alicePaired.deviceToken}`, "X-King-AI-Tenant": bobSummary.tenantId },
    }),
    bindings,
  );
  assert.equal(crossTenantToken.status, 401);

  const bobState = await json<{ messages: { body: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state", { headers: bobHeaders }), bindings),
  );
  assert.deepEqual(
    bobState.messages.map((message) => message.body),
    [],
  );
});

test("gui requires login when Better Auth is configured", async () => {
  const bindings = env(undefined, {
    AUTH_DB: {} as D1Database,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
  });

  const html = await worker.fetch(new Request("https://gui/"), bindings);
  assert.equal(html.status, 401);
  const body = await html.text();
  assert.match(body, /Continue with GitHub/);
  assert.match(body, /<svg class="github-icon" viewBox="0 0 16 16" aria-hidden="true">/);
  assert.match(body, /fetch\(location\.origin \+ '\/api\/auth\/sign-in\/social'/);
  assert.match(body, /callbackURL: location\.origin \+ '\/'/);
  assert.doesNotMatch(body, /<span class="github-icon">G<\/span>/);

  const state = await worker.fetch(new Request("https://gui/gui/state"), bindings);
  assert.equal(state.status, 401);
  assert.deepEqual(await state.json(), { error: "login_required" });
});

test("gui page exposes attachment controls in the composer", async () => {
  const bindings = env();
  const page = await worker.fetch(new Request("https://gui/"), bindings);
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /id="attachmentInput"/);
  assert.match(body, /openAttachmentPicker\(\)/);
  assert.match(body, /data-i18n="attachFile"/);
  assert.match(body, /\.attachment-token/);
  assert.match(body, /function isImageAttachment/);
  assert.match(body, /function preloadAttachmentImages/);
  assert.match(body, /function readImageDimensions/);
  assert.match(body, /function fittedAttachmentPreviewSize/);
  assert.match(body, /function attachmentPreviewMaxWidth/);
  assert.match(body, /const maxW = attachmentPreviewMaxWidth\(\)/);
  assert.match(body, /has-preview-size/);
  assert.match(body, /function attachmentPreviewLoaded/);
  assert.match(body, /attachment-preview-placeholder/);
  assert.match(body, /attachment-preview-image/);
  assert.match(body, /\[' \+ escapeHtml\(file\.name\) \+ '\]/);
});

test("gui page inline scripts are parseable", async () => {
  const bindings = env();
  const page = await worker.fetch(new Request("https://gui/"), bindings);
  assert.equal(page.status, 200);
  const body = await page.text();
  const scripts = [...body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");
  assert.equal(scripts.length, 2);
  for (const script of scripts) {
    assert.doesNotThrow(() => new Function(script));
  }
  assert.doesNotMatch(body, /\^\/remote-devices\/\//);
});

test("gui still requires login on localhost when Better Auth is configured", async () => {
  const bindings = env(undefined, {
    AUTH_DB: {} as D1Database,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
  });

  const html = await worker.fetch(new Request("http://127.0.0.1/"), bindings);
  assert.equal(html.status, 401);

  const state = await worker.fetch(new Request("http://127.0.0.1/gui/state"), bindings);
  assert.equal(state.status, 401);
  assert.deepEqual(await state.json(), { error: "login_required" });
});

test("gui uses Better Auth user identity as tenant", async () => {
  const bindings = env(undefined, {
    AUTH_DB: {} as D1Database,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
    KING_AI_TEST_AUTH_USER: "1",
  });
  const headers = {
    "X-King-AI-Test-User": JSON.stringify({ id: "github-1", email: "octo@example.com", name: "Octo" }),
  };

  const page = await worker.fetch(new Request("https://gui/", { headers }), bindings);
  assert.equal(page.status, 200);

  const summary = await json<{
    pairingCode: string;
    pairingLocator: string;
    tenantId: string;
    pairCommandTenantArg: string;
    currentUser?: { id: string; email?: string; name?: string };
  }>(await worker.fetch(new Request("https://gui/gui/summary", { headers }), bindings));
  assert.equal(summary.tenantId, "user-octo-example.com");
  assert.match(summary.pairingCode, /^user-octo-example\.com:/);
  assert.match(summary.pairingLocator, /tenant=user-octo-example.com/);
  assert.equal(summary.pairCommandTenantArg, "");
  assert.deepEqual(summary.currentUser, { id: "github-1", email: "octo@example.com", name: "Octo" });
});

test("gui remote assist link grants reusable tenant access without GitHub login", async () => {
  const bindings = env(undefined, {
    AUTH_DB: {} as D1Database,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
    KING_AI_TEST_AUTH_USER: "1",
  });
  const ownerHeaders = {
    "X-King-AI-Test-User": JSON.stringify({ id: "github-1", email: "octo@example.com", name: "Octo" }),
  };

  const blocked = await worker.fetch(new Request("https://gui/gui/state"), bindings);
  assert.equal(blocked.status, 401);

  const shared = await json<{
    url: string;
    remoteAssist: { active: boolean; tokenPreview: string; createdAt: number; uses: number };
  }>(
    await worker.fetch(
      new Request("https://gui/gui/remote-assist/share", {
        method: "POST",
        headers: ownerHeaders,
      }),
      bindings,
    ),
  );
  assert.match(shared.url, /^https:\/\/gui\/\?/);
  assert.match(shared.url, /tenant=user-octo-example.com/);
  assert.match(shared.url, /assist=/);
  assert.equal(shared.remoteAssist.active, true);
  assert.ok(shared.remoteAssist.createdAt <= Date.now());
  const ownerSummary = await json<{ pairingCode: string; tenantId: string }>(
    await worker.fetch(new Request("https://gui/gui/summary", { headers: ownerHeaders }), bindings),
  );
  const paired = await json<{ deviceToken: string; tenantId: string }>(
    await worker.fetch(
      new Request("https://gui/api/computers/pair", {
        method: "POST",
        body: JSON.stringify({ code: ownerSummary.pairingCode, engines: ["codex"] }),
      }),
      bindings,
    ),
  );
  assert.equal(paired.tenantId, ownerSummary.tenantId);
  await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}`, "X-King-AI-Tenant": ownerSummary.tenantId },
      }),
      bindings,
    ),
  );

  const page = await worker.fetch(new Request(shared.url), bindings);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Remote Assist/);

  const assistSummary = await json<{
    tenantId: string;
    pairingCode?: string;
    pairingLocator?: string;
    access?: { remoteAssist?: boolean };
    remoteAssist?: { active?: boolean };
  }>(await worker.fetch(new Request(shared.url.replace("https://gui/", "https://gui/gui/summary")), bindings));
  assert.equal(assistSummary.tenantId, "user-octo-example.com");
  assert.equal(assistSummary.access?.remoteAssist, true);
  assert.equal(assistSummary.remoteAssist?.active, true);
  assert.equal(assistSummary.pairingCode, undefined);
  assert.equal(assistSummary.pairingLocator, undefined);

  const assistState = await json<Record<string, unknown>>(
    await worker.fetch(new Request(shared.url.replace("https://gui/", "https://gui/gui/state")), bindings),
  );
  assert.equal("deviceToken" in assistState, false);
  assert.equal("runtimeToken" in assistState, false);
  assert.equal("runtimeTokens" in assistState, false);
  assert.equal("runtimeTokenMeta" in assistState, false);
  assert.equal("pairingCode" in assistState, false);
  assert.equal("remoteAssist" in assistState, false);

  await json<{ ok: true }>(
    await worker.fetch(
      new Request(shared.url.replace("https://gui/", "https://gui/gui/message"), {
        method: "POST",
        body: JSON.stringify({ body: "from teammate one" }),
      }),
      bindings,
    ),
  );
  await json<{ ok: true }>(
    await worker.fetch(
      new Request(shared.url.replace("https://gui/", "https://gui/gui/message"), {
        method: "POST",
        body: JSON.stringify({ body: "from teammate two" }),
      }),
      bindings,
    ),
  );
  const ownerState = await json<{ messages: { body: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state", { headers: ownerHeaders }), bindings),
  );
  assert.equal(
    ownerState.messages.some((message) => message.body === "from teammate one"),
    true,
  );
  assert.equal(
    ownerState.messages.some((message) => message.body === "from teammate two"),
    true,
  );

  const cannotShare = await worker.fetch(
    new Request(shared.url.replace("https://gui/", "https://gui/gui/remote-assist/share"), {
      method: "POST",
      body: JSON.stringify({}),
    }),
    bindings,
  );
  assert.equal(cannotShare.status, 403);
  const cannotExport = await worker.fetch(
    new Request(shared.url.replace("https://gui/", "https://gui/gui/export-state")),
    bindings,
  );
  assert.equal(cannotExport.status, 403);
  const cannotReset = await worker.fetch(
    new Request(shared.url.replace("https://gui/", "https://gui/gui/reset-state"), {
      method: "POST",
      body: JSON.stringify({}),
    }),
    bindings,
  );
  assert.equal(cannotReset.status, 403);
  const cannotConfig = await worker.fetch(
    new Request(shared.url.replace("https://gui/", "https://gui/gui/agent-config"), {
      method: "POST",
      body: JSON.stringify({ engine: "codex" }),
    }),
    bindings,
  );
  assert.equal(cannotConfig.status, 403);

  await json<{ ok: true }>(
    await worker.fetch(
      new Request("https://gui/gui/remote-assist/revoke", {
        method: "POST",
        headers: ownerHeaders,
      }),
      bindings,
    ),
  );
  const revoked = await worker.fetch(
    new Request(shared.url.replace("https://gui/", "https://gui/gui/state")),
    bindings,
  );
  assert.equal(revoked.status, 401);
});

test("gui messages use the authenticated user display name", async () => {
  const bindings = env(undefined, { KING_AI_TEST_AUTH_USER: "1" });
  const headers = {
    "X-King-AI-Test-User": JSON.stringify({ id: "github-1", email: "octo@example.com", name: "Octo" }),
  };
  const summary = await json<{ pairingCode: string; tenantId: string }>(
    await worker.fetch(new Request("https://gui/gui/summary", { headers }), bindings),
  );
  const paired = await json<{ deviceToken: string }>(
    await worker.fetch(
      new Request("https://gui/api/computers/pair", {
        method: "POST",
        headers,
        body: JSON.stringify({ code: summary.pairingCode, engines: ["codex"] }),
      }),
      bindings,
    ),
  );
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "hello from octo" }),
    }),
    bindings,
  );

  const state = await json<{ messages: { author_name: string; author_kind: string; body: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state", { headers }), bindings),
  );
  const human = state.messages.find((row) => row.author_kind === "human");
  assert.equal(human?.author_name, "Octo");

  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}`, "X-King-AI-Tenant": summary.tenantId },
      }),
      bindings,
    ),
  );
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}`, "X-King-AI-Tenant": summary.tenantId },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  assert.match((await callCli(["glance", "king-ai-convo"])).text, /Octo: hello from octo/);
  assert.match((await callCli(["contacts", "octo"])).text, /gui-human\tOcto\thuman\tRuntime operator/);
});

test("gui state renders message markdown with sanitized Comark html", async () => {
  const bindings = env();
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({
        body: "**bold** [ok](https://example.com) <script>alert(1)</script> [bad](javascript:alert(1))",
      }),
    }),
    bindings,
  );

  const state = await json<{ messages: { author_kind: string; body: string; body_html?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  const human = state.messages.find((message) => message.author_kind === "human");
  assert.equal(human?.body.includes("**bold**"), true);
  assert.match(human?.body_html ?? "", /<strong>bold<\/strong>/);
  assert.match(
    human?.body_html ?? "",
    /<a href="https:\/\/example\.com" target="_blank" rel="noreferrer noopener">ok<\/a>/,
  );
  assert.doesNotMatch(human?.body_html ?? "", /<script|href="javascript:/i);

  const exported = await json<{ state: { messages: { body_html?: string }[] } }>(
    await worker.fetch(new Request("https://gui/gui/export-state"), bindings),
  );
  assert.equal(
    exported.state.messages.some((message) => message.body_html),
    false,
  );
});

test("gui state renders IELTS learning annotations", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const room = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "IELTS Markup", workflowId: "ielts-study", teamMode: "single" }),
      }),
      bindings,
    ),
  );
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/ielts-tutor/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const posted = await json<{ exitCode: number; text: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/cli", {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          argv: [
            "reply",
            room.conversation.id,
            [
              "I have been working overtime for almost two weeks.",
              "",
              `WordCards: ${JSON.stringify({
                sentences: [
                  {
                    text: "I have been working overtime for almost two weeks.",
                    clauses: [
                      {
                        text: "I have been working overtime for almost two weeks",
                        core: "I have been working",
                        phrases: ["for almost two weeks"],
                      },
                    ],
                  },
                ],
                cards: ["I", "have", "been", "working", "for", "almost", "two", "weeks"]
                  .map((token) => cardJson(token))
                  .concat([
                    cardJson("overtime", {
                      meaningZh: "加班时间",
                      phonetic: "/ˈoʊvərtaɪm/",
                      syllables: ["o", "ver", "time"],
                      partOfSpeech: "名词/副词",
                      roots: "over- 超过 + time 时间",
                    }),
                  ]),
              })}`,
            ].join("\n"),
          ],
        }),
      }),
      bindings,
    ),
  );
  assert.equal(posted.exitCode, 0, posted.text);

  const state = await json<{ messages: { author_kind: string; body_html?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  const agent = state.messages.find((message) => message.author_kind === "agent");
  assert.match(
    agent?.body_html ?? "",
    /class="ielts-core">[\s\S]*data-word="I"[^>]*>I<\/span>[\s\S]*data-word="working"[^>]*>working<\/span>[\s\S]*<\/span>/,
  );
  assert.match(
    agent?.body_html ?? "",
    /class="ielts-phrase">[\s\S]*data-word="for"[^>]*>for<\/span>[\s\S]*data-word="weeks"[^>]*>weeks<\/span>[\s\S]*<\/span>/,
  );
  assert.match(
    agent?.body_html ?? "",
    /class="ielts-word" data-word="overtime" data-meaning="加班时间" data-phonetic="\/ˈoʊvərtaɪm\/" data-syllables="o-ver-time" data-pos="名词\/副词" data-roots="over- 超过 \+ time 时间">overtime<\/span>/,
  );
});

test("workflow room unread clears once its own responding agent reads, not just the default agent", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const room = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "IELTS Unread", workflowId: "ielts-study", teamMode: "single" }),
      }),
      bindings,
    ),
  );
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "早上好啊，老师", conversationId: room.conversation.id }),
    }),
    bindings,
  );

  const before = await json<{ conversations: { id: string; unread: number }[] }>(
    await worker.fetch(new Request("https://gui/gui/summary"), bindings),
  );
  assert.equal(before.conversations.find((row) => row.id === room.conversation.id)?.unread, 1);

  const state = await json<{ messages: { id: string; conversation_id: string; author_kind: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  const humanMessage = state.messages.find(
    (message) => message.conversation_id === room.conversation.id && message.author_kind === "human",
  );
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/ielts-tutor/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  // The IELTS coach (not king-ai-ceo) reads the room; the human message is now handled.
  await worker.fetch(
    new Request("https://gui/runtime/conversation/mark-read", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: room.conversation.id, upToMessageId: humanMessage?.id }),
    }),
    bindings,
  );

  const after = await json<{ conversations: { id: string; unread: number }[] }>(
    await worker.fetch(new Request("https://gui/gui/summary"), bindings),
  );
  assert.equal(after.conversations.find((row) => row.id === room.conversation.id)?.unread, 0);
});

test("gui state makes every IELTS coach English word clickable without explicit vocabulary markup", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const room = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "IELTS Words", workflowId: "ielts-study", teamMode: "single" }),
      }),
      bindings,
    ),
  );
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/ielts-tutor/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const posted = await json<{ exitCode: number; text: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/cli", {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          argv: [
            "reply",
            room.conversation.id,
            [
              "Yes, I am here, and I can help you improve your IELTS reading and writing.",
              "",
              structuredWordCards(
                [
                  {
                    text: "Yes, I am here, and I can help you improve your IELTS reading and writing.",
                    clauses: [
                      { text: "Yes, I am here", core: "I am", phrases: ["Yes", "here"] },
                      {
                        text: "and I can help you improve your IELTS reading and writing",
                        core: "I can help",
                        phrases: ["your IELTS reading and writing"],
                      },
                    ],
                  },
                ],
                [
                  "Yes",
                  "I",
                  "am",
                  "here",
                  "and",
                  "can",
                  "help",
                  "you",
                  "improve",
                  "your",
                  "IELTS",
                  "reading",
                  "writing",
                ],
              ),
            ].join("\n"),
          ],
        }),
      }),
      bindings,
    ),
  );
  assert.equal(posted.exitCode, 0, posted.text);

  const state = await json<{ messages: { author_kind: string; body_html?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  const agent = state.messages.find((message) => message.author_kind === "agent");
  for (const word of [
    "Yes",
    "I",
    "am",
    "here",
    "and",
    "can",
    "help",
    "you",
    "improve",
    "your",
    "IELTS",
    "reading",
    "writing",
  ]) {
    assert.match(agent?.body_html ?? "", new RegExp(`class="ielts-word" data-word="${word}"[^>]*>${word}<\\/span>`));
  }
  assert.match(agent?.body_html ?? "", /class="ielts-word" data-word="I" data-meaning="I 的中文义"[^>]*>I<\/span>/);
  assert.match(agent?.body_html ?? "", /data-word="and" data-meaning="and 的中文义"[^>]*>and<\/span>/);
});

test("gui state makes long IELTS coach sample paragraphs clickable", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const room = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "IELTS Sample", workflowId: "ielts-study", teamMode: "single" }),
      }),
      bindings,
    ),
  );
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/ielts-tutor/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const posted = await json<{ exitCode: number; text: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/cli", {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          argv: [
            "reply",
            room.conversation.id,
            [
              "Dear Sir or Madam,",
              "",
              "My name is Li Ming, and I am writing to introduce myself.",
              "I have developed a strong interest in English communication.",
              "",
              structuredWordCards(
                [
                  {
                    text: "Dear Sir or Madam,",
                    clauses: [{ text: "Dear Sir or Madam", core: "Dear Sir or Madam", phrases: [] }],
                  },
                  {
                    text: "My name is Li Ming, and I am writing to introduce myself.",
                    clauses: [
                      { text: "My name is Li Ming", core: "name is", phrases: ["Li Ming"] },
                      {
                        text: "and I am writing to introduce myself",
                        core: "I am writing",
                        phrases: ["to introduce myself"],
                      },
                    ],
                  },
                  {
                    text: "I have developed a strong interest in English communication.",
                    clauses: [
                      {
                        text: "I have developed a strong interest in English communication",
                        core: "I have developed",
                        phrases: ["a strong interest", "in English communication"],
                      },
                    ],
                  },
                ],
                [
                  "Dear",
                  "Sir",
                  "or",
                  "Madam",
                  "My",
                  "name",
                  "is",
                  "Li",
                  "Ming",
                  "and",
                  "I",
                  "am",
                  "writing",
                  "to",
                  "introduce",
                  "myself",
                  "have",
                  "developed",
                  "a",
                  "strong",
                  "interest",
                  "in",
                  "English",
                  "communication",
                ],
              ),
            ].join("\n"),
          ],
        }),
      }),
      bindings,
    ),
  );
  assert.equal(posted.exitCode, 0, posted.text);

  const state = await json<{ messages: { author_kind: string; body_html?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  const agent = state.messages.find((message) => message.author_kind === "agent");
  for (const word of [
    "Dear",
    "Madam",
    "name",
    "writing",
    "introduce",
    "developed",
    "strong",
    "interest",
    "communication",
  ]) {
    assert.match(agent?.body_html ?? "", new RegExp(`class="ielts-word" data-word="${word}"[^>]*>${word}<\\/span>`));
  }
});

test("gui state gives fallback IELTS word cards meaning phonetic and syllables", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const room = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "IELTS Fallback Cards", workflowId: "ielts-study", teamMode: "single" }),
      }),
      bindings,
    ),
  );
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/ielts-tutor/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const posted = await json<{ exitCode: number; text: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/cli", {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          argv: [
            "reply",
            room.conversation.id,
            [
              "Dear Hiring Manager,",
              "",
              "I am writing to apply for the programmer position at your company.",
              "I have developed practical skills in Java, Python, and web development through university projects and personal practice.",
              "",
              structuredWordCards(
                [
                  {
                    text: "Dear Hiring Manager,",
                    clauses: [{ text: "Dear Hiring Manager", core: "Dear Hiring Manager", phrases: [] }],
                  },
                  {
                    text: "I am writing to apply for the programmer position at your company.",
                    clauses: [
                      {
                        text: "I am writing to apply for the programmer position at your company",
                        core: "I am writing",
                        phrases: ["to apply for", "the programmer position", "at your company"],
                      },
                    ],
                  },
                  {
                    text: "I have developed practical skills in Java, Python, and web development through university projects and personal practice.",
                    clauses: [
                      {
                        text: "I have developed practical skills in Java, Python, and web development through university projects and personal practice",
                        core: "I have developed",
                        phrases: ["practical skills", "through university projects", "personal practice"],
                      },
                    ],
                  },
                ],
                [
                  "Dear",
                  "Hiring",
                  "Manager",
                  "I",
                  "am",
                  "writing",
                  "to",
                  "apply",
                  "for",
                  "the",
                  "programmer",
                  "position",
                  "at",
                  "your",
                  "company",
                  "have",
                  "developed",
                  "practical",
                  "skills",
                  "in",
                  "Java",
                  "Python",
                  "and",
                  "web",
                  "development",
                  "through",
                  "university",
                  "projects",
                  "personal",
                  "practice",
                ],
              ),
            ].join("\n"),
          ],
        }),
      }),
      bindings,
    ),
  );
  assert.equal(posted.exitCode, 0, posted.text);

  const state = await json<{ messages: { author_kind: string; body_html?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  const html = state.messages.find((message) => message.author_kind === "agent")?.body_html ?? "";
  for (const word of ["Hiring", "programmer", "company", "through", "university", "projects"]) {
    assert.match(
      html,
      new RegExp(
        `data-word="${word}" data-meaning="[^"]+" data-phonetic="[^"]+" data-syllables="[^"]+" data-pos="[^"]+"[^>]*>${word}<\\/span>`,
      ),
    );
  }
  assert.match(html, /data-word="Hiring" data-meaning="Hiring 的中文义"[^>]*data-pos="形容词"/);
  assert.match(html, /data-word="programmer" data-meaning="programmer 的中文义"[^>]*data-pos="名词"/);
  assert.match(html, /data-word="through" data-meaning="through 的中文义"[^>]*data-pos="介词"/);
});

test("gui state fills word cards from structured WordCards JSON and hides it", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const room = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "IELTS WordCards", workflowId: "ielts-study", teamMode: "single" }),
      }),
      bindings,
    ),
  );
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/ielts-tutor/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  await worker.fetch(
    new Request("https://gui/runtime/cli", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        argv: [
          "reply",
          room.conversation.id,
          [
            "I customized the dashboard for daily practice.",
            "",
            'WordCards: {"sentences":[{"text":"I customized the dashboard for daily practice.","clauses":[{"text":"I customized the dashboard for daily practice","core":"I customized","phrases":["the dashboard","for daily practice"]}]}],"cards":[{"token":"I","lemma":"I","meaningZh":"我","phonetic":"/aɪ/","syllables":["I"]},{"token":"customized","lemma":"customize","meaningZh":"定制；个性化调整","phonetic":"/ˈkʌstəmaɪzd/","syllables":["cus","tom","ized"]},{"token":"the","lemma":"the","meaningZh":"这；那","phonetic":"/ðə/","syllables":["the"]},{"token":"dashboard","lemma":"dashboard","meaningZh":"仪表盘；信息面板","phonetic":"/ˈdæʃbɔːrd/","syllables":["dash","board"]},{"token":"for","lemma":"for","meaningZh":"为了；给","phonetic":"/fɔːr/","syllables":["for"]},{"token":"daily","lemma":"daily","meaningZh":"每日的","phonetic":"/ˈdeɪli/","syllables":["dai","ly"]},{"token":"practice","lemma":"practice","meaningZh":"练习","phonetic":"/ˈpræktɪs/","syllables":["prac","tice"]}]}',
          ].join("\n"),
        ],
      }),
    }),
    bindings,
  );

  const state = await json<{ messages: { author_kind: string; body_html?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  const html = state.messages.find((message) => message.author_kind === "agent")?.body_html ?? "";
  for (const word of ["I", "customized", "the", "dashboard", "for", "daily", "practice"]) {
    assert.match(
      html,
      new RegExp(
        `data-word="${word}" data-meaning="[^"]+" data-phonetic="[^"]+" data-syllables="[^"]+"[^>]*>${word}<\\/span>`,
      ),
    );
  }
  assert.match(
    html,
    /data-word="customized" data-meaning="定制；个性化调整" data-phonetic="\/ˈkʌstəmaɪzd\/" data-syllables="cus-tom-ized"[^>]*>customized<\/span>/,
  );
  assert.match(
    html,
    /data-word="dashboard" data-meaning="仪表盘；信息面板" data-phonetic="\/ˈdæʃbɔːrd\/" data-syllables="dash-board"[^>]*>dashboard<\/span>/,
  );
  assert.doesNotMatch(html, /WordCards/);
});

test("gui state renders IELTS sentence and clause annotations from structured WordCards JSON", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const room = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "IELTS Structured Clauses", workflowId: "ielts-study", teamMode: "single" }),
      }),
      bindings,
    ),
  );
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/ielts-tutor/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  await worker.fetch(
    new Request("https://gui/runtime/cli", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        argv: [
          "reply",
          room.conversation.id,
          [
            "Your smile gives my days light, even when life feels heavy.",
            "",
            structuredWordCards(
              [
                {
                  text: "Your smile gives my days light, even when life feels heavy.",
                  clauses: [
                    { text: "Your smile gives my days light", core: "Your smile gives", phrases: ["my days light"] },
                    { text: "even when life feels heavy", core: "life feels", phrases: ["even when", "heavy"] },
                  ],
                },
              ],
              ["Your", "smile", "gives", "my", "days", "light", "even", "when", "life", "feels", "heavy"],
            ),
          ].join("\n"),
        ],
      }),
    }),
    bindings,
  );

  const state = await json<{ messages: { author_kind: string; body_html?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  const html = state.messages.find((message) => message.author_kind === "agent")?.body_html ?? "";
  const coreMatches = html.match(/class="ielts-core"/g) ?? [];
  assert.equal(coreMatches.length, 2);
  assert.match(
    html,
    /class="ielts-core"><span class="ielts-word" data-word="Your"[^>]*>Your<\/span> <span class="ielts-word" data-word="smile"[^>]*>smile<\/span> <span class="ielts-word" data-word="gives"[^>]*>gives<\/span><\/span>/,
  );
  assert.match(
    html,
    /class="ielts-core"><span class="ielts-word" data-word="life"[^>]*>life<\/span> <span class="ielts-word" data-word="feels"[^>]*>feels<\/span><\/span>/,
  );
  assert.match(
    html,
    /class="ielts-phrase"><span class="ielts-word" data-word="even"[^>]*>even<\/span> <span class="ielts-word" data-word="when"[^>]*>when<\/span><\/span>/,
  );
  assert.doesNotMatch(html, /WordCards/);
});

test("gui state cards possessives via the base word and contractions via the dictionary", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const room = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "IELTS Possessive", workflowId: "ielts-study", teamMode: "single" }),
      }),
      bindings,
    ),
  );
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/ielts-tutor/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  await worker.fetch(
    new Request("https://gui/runtime/cli", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        argv: [
          "reply",
          room.conversation.id,
          [
            "I don't think the teacher's notes helped much.",
            "",
            'WordCards: {"sentences":[{"text":"I don\'t think the teacher\'s notes helped much.","clauses":[{"text":"I don\'t think the teacher\'s notes helped much","core":"I don\'t think","phrases":["the teacher\'s notes"]}]}],"cards":[{"token":"I","meaningZh":"我","phonetic":"/aɪ/","syllables":["I"]},{"token":"don\'t","meaningZh":"不（do not）","phonetic":"/doʊnt/","syllables":["don\'t"]},{"token":"think","meaningZh":"认为","phonetic":"/θɪŋk/","syllables":["think"]},{"token":"the","meaningZh":"这；那","phonetic":"/ðə/","syllables":["the"]},{"token":"teacher","meaningZh":"老师","phonetic":"/ˈtiːtʃər/","syllables":["teach","er"]},{"token":"notes","meaningZh":"笔记","phonetic":"/noʊts/","syllables":["notes"]},{"token":"helped","meaningZh":"帮助了","phonetic":"/helpt/","syllables":["helped"]},{"token":"much","meaningZh":"许多","phonetic":"/mʌtʃ/","syllables":["much"]}]}',
          ].join("\n"),
        ],
      }),
    }),
    bindings,
  );

  const state = await json<{ messages: { author_kind: string; body_html?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  const html = state.messages.find((message) => message.author_kind === "agent")?.body_html ?? "";
  // teacher's falls back to the base word "teacher" from WordCards.
  assert.match(html, /data-meaning="老师"/);
  // don't keeps its own dictionary card rather than being stripped to "don".
  assert.match(html, /data-meaning="不（do not）"/);
  assert.doesNotMatch(html, /WordCards/);
});

test("gui state keeps markdown structure while annotating IELTS coach replies", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const room = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "IELTS Markdown", workflowId: "ielts-study", teamMode: "single" }),
      }),
      bindings,
    ),
  );
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/ielts-tutor/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  await worker.fetch(
    new Request("https://gui/runtime/cli", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        argv: [
          "reply",
          room.conversation.id,
          [
            "**Tips**:",
            "",
            "- Plan your essay before writing.",
            "- Review grammar carefully.",
            "",
            'WordCards: {"sentences":[{"text":"Tips:","clauses":[{"text":"Tips","core":"Tips","phrases":[]}]},{"text":"Plan your essay before writing.","clauses":[{"text":"Plan your essay before writing","core":"Plan your essay","phrases":["before writing"]}]},{"text":"Review grammar carefully.","clauses":[{"text":"Review grammar carefully","core":"Review grammar","phrases":["carefully"]}]}],"cards":[{"token":"Tips","meaningZh":"提示","phonetic":"/tɪps/","syllables":["tips"]},{"token":"Plan","meaningZh":"计划","phonetic":"/plæn/","syllables":["plan"]},{"token":"your","meaningZh":"你的","phonetic":"/jɔːr/","syllables":["your"]},{"token":"essay","meaningZh":"文章","phonetic":"/ˈeseɪ/","syllables":["es","say"]},{"token":"before","meaningZh":"在之前","phonetic":"/bɪˈfɔːr/","syllables":["be","fore"]},{"token":"writing","meaningZh":"写作","phonetic":"/ˈraɪtɪŋ/","syllables":["writ","ing"]},{"token":"Review","meaningZh":"检查","phonetic":"/rɪˈvjuː/","syllables":["re","view"]},{"token":"grammar","meaningZh":"语法","phonetic":"/ˈɡræmər/","syllables":["gram","mar"]},{"token":"carefully","meaningZh":"仔细地","phonetic":"/ˈkerfəli/","syllables":["care","ful","ly"]}]}',
          ].join("\n"),
        ],
      }),
    }),
    bindings,
  );

  const state = await json<{ messages: { author_kind: string; body_html?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  const html = state.messages.find((message) => message.author_kind === "agent")?.body_html ?? "";
  // markdown still renders into list/bold structure, and a bold sentence core is highlighted
  // (and carded) even though the `**Tips**` emphasis sits between the core text and the markup
  assert.match(html, /<li>/);
  assert.match(html, /<strong><span class="ielts-core"><span class="ielts-word"[^>]*>Tips<\/span><\/span><\/strong>/);
  // cores render inside the list items and content words still get glossary cards
  assert.match(html, /class="ielts-core"/);
  assert.match(html, /data-word="essay" data-meaning="文章"/);
  // no markers leak into the rendered output
  assert.doesNotMatch(html, /\[core:/);
  assert.doesNotMatch(html, /\[phrase:/);
  assert.doesNotMatch(html, /WordCards/);
});

test("gui state highlights IELTS cores even when the sentence carries markdown emphasis", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const room = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "IELTS Emphasis", workflowId: "ielts-study", teamMode: "single" }),
      }),
      bindings,
    ),
  );
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/ielts-tutor/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  await worker.fetch(
    new Request("https://gui/runtime/cli", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        argv: [
          "reply",
          room.conversation.id,
          [
            "Practice makes **perfect** for every test.",
            "",
            structuredWordCards(
              [
                {
                  text: "Practice makes perfect for every test.",
                  clauses: [
                    { text: "Practice makes perfect for every test", core: "Practice makes", phrases: ["every test"] },
                  ],
                },
              ],
              ["Practice", "makes", "perfect", "for", "every", "test"],
            ),
          ].join("\n"),
        ],
      }),
    }),
    bindings,
  );

  const state = await json<{ messages: { author_kind: string; body_html?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  const html = state.messages.find((message) => message.author_kind === "agent")?.body_html ?? "";
  // the core before the bold word still highlights, and the bold word is still a markdown <strong>
  assert.match(
    html,
    /class="ielts-core"><span class="ielts-word" data-word="Practice"[^>]*>Practice<\/span> <span class="ielts-word" data-word="makes"[^>]*>makes<\/span><\/span>/,
  );
  assert.match(html, /<strong><span class="ielts-word"[^>]*>perfect<\/span><\/strong>/);
  assert.match(html, /class="ielts-phrase"><span class="ielts-word" data-word="every"/);
  assert.doesNotMatch(html, /WordCards/);
});

test("gui state recalls past agent messages through the episodic FTS index", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const room = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "Episodic", workflowId: "ielts-study", teamMode: "single" }),
      }),
      bindings,
    ),
  );
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/ielts-tutor/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const cli = (argv: string[]) =>
    worker.fetch(
      new Request("https://gui/runtime/cli", {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ argv }),
      }),
      bindings,
    );
  await cli([
    "reply",
    room.conversation.id,
    [
      "We finalized the mitochondria decision for the biology essay.",
      "",
      structuredWordCards(
        [
          {
            text: "We finalized the mitochondria decision for the biology essay.",
            clauses: [
              {
                text: "We finalized the mitochondria decision for the biology essay",
                core: "We finalized",
                phrases: ["the mitochondria decision", "for the biology essay"],
              },
            ],
          },
        ],
        ["We", "finalized", "the", "mitochondria", "decision", "for", "biology", "essay"],
      ),
    ].join("\n"),
  ]);

  const recalled = await json<{ text: string }>(await cli(["recall", "mitochondria"]));
  assert.match(recalled.text, /mitochondria/i);
  assert.match(recalled.text, new RegExp(room.conversation.id));

  const miss = await json<{ text: string }>(await cli(["recall", "zzzznotpresentkeyword"]));
  assert.match(miss.text, /No episodic memory found/);
});

test("gui state renders nested IELTS highlights from structured clauses", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const room = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "IELTS Inline", workflowId: "ielts-study", teamMode: "single" }),
      }),
      bindings,
    ),
  );
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/ielts-tutor/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  await worker.fetch(
    new Request("https://gui/runtime/cli", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        argv: [
          "reply",
          room.conversation.id,
          [
            "I want to eat.",
            "",
            'WordCards: {"sentences":[{"text":"I want to eat.","clauses":[{"text":"I want to eat","core":"I want","phrases":["to eat"]}]}],"cards":[{"token":"I","meaningZh":"我","phonetic":"/aɪ/","syllables":["I"]},{"token":"want","meaningZh":"想要","phonetic":"/wɑːnt/","syllables":["want"]},{"token":"to","meaningZh":"去；向","phonetic":"/tuː/","syllables":["to"]},{"token":"eat","meaningZh":"吃","phonetic":"/iːt/","syllables":["eat"]}]}',
          ].join("\n"),
        ],
      }),
    }),
    bindings,
  );

  const state = await json<{ messages: { author_kind: string; body_html?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  const agent = state.messages.find((message) => message.author_kind === "agent");
  assert.match(
    agent?.body_html ?? "",
    /<span class="ielts-core"><span class="ielts-word" data-word="I"[^>]*>I<\/span> <span class="ielts-word" data-word="want" data-meaning="想要" data-phonetic="\/wɑːnt\/" data-syllables="want">want<\/span><\/span> <span class="ielts-phrase"><span class="ielts-word" data-word="to"[^>]*>to<\/span> <span class="ielts-word" data-word="eat" data-meaning="吃"[^>]*>eat<\/span><\/span>\./,
  );
});

test("gui messages preserve attachment metadata for runtime prompts", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const upload = await json<{ attachment: { id: string; name: string; mime: string; size: number; url: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/attachments", {
        method: "POST",
        body: JSON.stringify({
          name: "screen.png",
          mime: "image/png",
          size: 4,
          bytesBase64: Buffer.from("pong", "utf8").toString("base64"),
        }),
      }),
      bindings,
    ),
  );
  assert.match(upload.attachment.url, /\/gui\/attachments\/att-/);
  const download = await worker.fetch(new Request(upload.attachment.url), bindings);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("Content-Disposition") ?? "", /inline/);
  assert.equal(await download.text(), "pong");
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({
        body: "inspect attachment",
        attachments: [{ id: upload.attachment.id, name: "screen.png", mime: "image/png", size: 42, required: true }],
      }),
    }),
    bindings,
  );

  const state = await json<{
    messages: { author_kind: string; attachments?: { name: string; decision: string; url?: string }[] }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const human = state.messages.find((message) => message.author_kind === "human");
  assert.equal(human?.attachments?.[0]?.name, "screen.png");
  assert.equal(human?.attachments?.[0]?.decision, "accepted");
  assert.match(human?.attachments?.[0]?.url ?? "", /\/gui\/attachments\//);

  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const preamble = await json<{ text: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/preamble?agent=king-ai-ceo", {
        headers: { Authorization: `Bearer ${tokenRes.token}` },
      }),
      bindings,
    ),
  );
  assert.match(preamble.text, /Runtime attachments/);
  assert.match(preamble.text, /\[screen\.png\] image\/png 42B/);
  assert.match(preamble.text, /\/gui\/attachments\//);
});

test("gui attachments store large files outside the shared state value", async () => {
  const bindings = env();
  const largeHtml = `<!doctype html><title>large</title><main>${"x".repeat(2_200_000)}</main>`;
  const upload = await json<{ attachment: { id: string; name: string; mime: string; size: number; url: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/attachments", {
        method: "POST",
        body: JSON.stringify({
          name: "large.html",
          mime: "text/html",
          size: Buffer.byteLength(largeHtml),
          bytesBase64: Buffer.from(largeHtml, "utf8").toString("base64"),
        }),
      }),
      bindings,
    ),
  );
  assert.equal(upload.attachment.size, Buffer.byteLength(largeHtml));

  const state = await json<{ uploads: Record<string, { name: string; bytesBase64?: string; chunkCount?: number }> }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.equal(state.uploads[upload.attachment.id]?.name, "large.html");
  assert.equal(state.uploads[upload.attachment.id]?.bytesBase64, undefined);
  assert.equal((state.uploads[upload.attachment.id]?.chunkCount ?? 0) > 1, true);

  const download = await worker.fetch(new Request(upload.attachment.url), bindings);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), largeHtml);
});

test("gui html attachments remain readable in runtime prompts", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const html = "<!doctype html><title>prototype</title>";
  const upload = await json<{ attachment: { id: string; name: string; mime: string; size: number; url: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/attachments", {
        method: "POST",
        body: JSON.stringify({
          name: "prototype.html",
          mime: "text/html",
          size: Buffer.byteLength(html),
          bytesBase64: Buffer.from(html, "utf8").toString("base64"),
        }),
      }),
      bindings,
    ),
  );
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({
        body: "read html",
        attachments: [
          {
            id: upload.attachment.id,
            name: upload.attachment.name,
            mime: upload.attachment.mime,
            size: upload.attachment.size,
            required: true,
          },
        ],
      }),
    }),
    bindings,
  );

  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const preamble = await json<{ text: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/preamble?agent=king-ai-ceo", {
        headers: { Authorization: `Bearer ${tokenRes.token}` },
      }),
      bindings,
    ),
  );
  assert.match(preamble.text, /\[prototype\.html\] text\/html/);
  assert.doesNotMatch(preamble.text, /unsupported-file-mime/);
});

test("gui attachment token URLs are readable by local runtimes without browser login", async () => {
  const bindings = env(undefined, {
    AUTH_DB: {} as D1Database,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
    KING_AI_TEST_AUTH_USER: "1",
  });
  const headers = {
    "X-King-AI-Test-User": JSON.stringify({ id: "github-1", email: "octo@example.com", name: "Octo" }),
  };
  const upload = await json<{ attachment: { url: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/attachments", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "screen.png",
          mime: "image/png",
          size: 4,
          bytesBase64: Buffer.from("pong", "utf8").toString("base64"),
        }),
      }),
      bindings,
    ),
  );
  assert.match(upload.attachment.url, /tenant=user-octo-example\.com/);

  const unauthenticated = await worker.fetch(new Request(upload.attachment.url), bindings);
  assert.equal(unauthenticated.status, 200);
  assert.equal(unauthenticated.headers.get("Content-Type"), "image/png");
  assert.equal(await unauthenticated.text(), "pong");
});

test("gui runtime marks read only through the requested message", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["claude", "codex"] });
  const guiState = await json<{ availableEngines: string[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.deepEqual(guiState.availableEngines, ["claude", "codex"]);

  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );

  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "first" }),
    }),
    bindings,
  );
  const firstInbox = await json<{ rows: { id: string }[] }>(
    await worker.fetch(
      new Request("https://gui/runtime/inbox", {
        headers: { Authorization: `Bearer ${tokenRes.token}` },
      }),
      bindings,
    ),
  );
  const firstId = firstInbox.rows[0]?.id;
  assert.equal(typeof firstId, "string");

  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "second" }),
    }),
    bindings,
  );
  await worker.fetch(
    new Request("https://gui/runtime/conversation/mark-read", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "king-ai-convo", upToMessageId: firstId }),
    }),
    bindings,
  );

  const inbox = await json<{ rows: { body: string }[]; routeSummary?: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/inbox", {
        headers: { Authorization: `Bearer ${tokenRes.token}` },
      }),
      bindings,
    ),
  );
  assert.deepEqual(
    inbox.rows.map((row) => row.body),
    ["second"],
  );
  assert.match(inbox.routeSummary ?? "", /respond\/normal\/msg/);
});

test("gui all window routes team collaboration across CEO, dev, and reviewer agents", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const ceoToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const devToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/dev/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const reviewerToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/reviewer/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );

  const agents = await json<{ id: string; name: string }[]>(
    await worker.fetch(
      new Request("https://gui/api/computers/me/agents", {
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  assert.deepEqual(agents.map((agent) => agent.id).slice(0, 3), ["king-ai-ceo", "dev", "reviewer"]);
  assert.equal(agents.length, 4);
  assert.equal(
    agents.some((agent) => agent.id === "tester"),
    false,
  );
  assert.equal(
    agents.some((agent) => agent.id === "ops"),
    false,
  );
  assert.equal(
    agents.some((agent) => agent.id === "researcher"),
    false,
  );
  assert.equal(
    agents.some((agent) => agent.id === "doc-writer"),
    false,
  );

  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "请团队实现多角色协作" }),
    }),
    bindings,
  );

  const ceoInbox = await json<{ rows: { body: string; to_agent_id?: string }[] }>(
    await worker.fetch(
      new Request("https://gui/runtime/inbox", {
        headers: { Authorization: `Bearer ${ceoToken.token}` },
      }),
      bindings,
    ),
  );
  assert.equal(ceoInbox.rows[0]?.body, "请团队实现多角色协作");
  assert.equal(ceoInbox.rows[0]?.to_agent_id, "king-ai-ceo");

  const devInbox = await json<{ rows: { body: string }[] }>(
    await worker.fetch(
      new Request("https://gui/runtime/inbox", {
        headers: { Authorization: `Bearer ${devToken.token}` },
      }),
      bindings,
    ),
  );
  assert.equal(
    devInbox.rows.some((row) => row.body.includes("Task assigned")),
    true,
  );

  const afterMessage = await json<{
    tasks: { id: string; title: string; assignee?: string; status: string; requestMessageId?: string }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const delegatedTask = afterMessage.tasks.find((task) => task.title.includes("请团队实现多角色协作"));
  assert.equal(delegatedTask?.assignee, "dev");
  assert.equal(delegatedTask?.status, "assigned");

  const devAgenda = await json<{ actionable: boolean; brief: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/agenda", {
        headers: { Authorization: `Bearer ${devToken.token}` },
      }),
      bindings,
    ),
  );
  assert.equal(devAgenda.actionable, true);
  assert.match(devAgenda.brief, /请团队实现多角色协作/);

  await json<{ task: { assignee?: string; status: string } }>(
    await worker.fetch(
      new Request(`https://gui/gui/task/${delegatedTask?.id}/update`, {
        method: "POST",
        body: JSON.stringify({ status: "review", result: "dev ready" }),
      }),
      bindings,
    ),
  );
  const reviewerAgenda = await json<{ actionable: boolean; brief: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/agenda", {
        headers: { Authorization: `Bearer ${reviewerToken.token}` },
      }),
      bindings,
    ),
  );
  assert.equal(reviewerAgenda.actionable, true);
  assert.match(reviewerAgenda.brief, /请团队实现多角色协作/);

  const reviewerInbox = await json<{ rows: { to_agent_id?: string; body: string }[] }>(
    await worker.fetch(
      new Request("https://gui/runtime/inbox", {
        headers: { Authorization: `Bearer ${reviewerToken.token}` },
      }),
      bindings,
    ),
  );
  assert.equal(
    reviewerInbox.rows.some((row) => row.to_agent_id === "reviewer" && row.body.includes("Task assigned")),
    true,
  );

  const summary = await json<{ agents: { id: string; unreadMessages: number; openTasks: number }[] }>(
    await worker.fetch(new Request("https://gui/gui/summary"), bindings),
  );
  assert.deepEqual(summary.agents.map((agent) => agent.id).slice(0, 3), ["king-ai-ceo", "dev", "reviewer"]);
  assert.equal(
    summary.agents.some((agent) => agent.id === "tester"),
    false,
  );
  assert.equal(summary.agents.find((agent) => agent.id === "reviewer")?.openTasks, 1);
  assert.equal(summary.agents.find((agent) => agent.id === "reviewer")?.unreadMessages, 1);
});

test("gui wake events target the assigned collaborator", async () => {
  const bindings = env();
  await pairComputer(bindings, { engines: ["codex"] });
  const created = await json<{ task: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/task", {
        method: "POST",
        body: JSON.stringify({ title: "Target dev wake" }),
      }),
      bindings,
    ),
  );

  const state = await json<{
    wakeLog?: { event: string; data: { agentId?: string; taskId?: string; agenda?: boolean } }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const wake = state.wakeLog?.find((row) => row.event === "wake" && row.data.taskId === created.task.id);
  assert.equal(wake?.data.agentId, "dev");
  assert.equal(wake?.data.agenda, true);
});

test("cli task done handoff broadcasts wake to the routed reviewer", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const devToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/dev/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );

  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "@dev roll call reply" }),
    }),
    bindings,
  );

  const beforeDone = await json<{
    tasks: { id: string; assignee?: string; status: string }[];
    wakeLog?: { event: string; data: { agentId?: string; taskId?: string; agenda?: boolean } }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const task = beforeDone.tasks.find((row) => row.assignee === "dev" && row.status === "assigned");
  assert.ok(task);

  await worker.fetch(
    new Request("https://gui/runtime/cli", {
      method: "POST",
      headers: { Authorization: `Bearer ${devToken.token}` },
      body: JSON.stringify({ argv: ["task", "done", task.id, "dev roll call ok"] }),
    }),
    bindings,
  );

  const afterDone = await json<{
    tasks: { id: string; assignee?: string; status: string }[];
    wakeLog?: { event: string; data: { agentId?: string; taskId?: string; agenda?: boolean } }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const routed = afterDone.tasks.find((row) => row.id === task.id);
  assert.equal(routed?.status, "review");
  assert.equal(routed?.assignee, "reviewer");
  assert.equal(
    afterDone.wakeLog?.some(
      (row) =>
        row.event === "wake" &&
        row.data.agentId === "reviewer" &&
        row.data.taskId === task.id &&
        row.data.agenda === true,
    ),
    true,
  );
});

test("cli reviewer approval broadcasts wake to the coordinator for loop closing", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const devToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/dev/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const reviewerToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/reviewer/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );

  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "@dev ship the review handoff" }),
    }),
    bindings,
  );

  const assigned = await json<{ tasks: { id: string; assignee?: string; status: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  const task = assigned.tasks.find((row) => row.assignee === "dev" && row.status === "assigned");
  assert.ok(task);

  await worker.fetch(
    new Request("https://gui/runtime/cli", {
      method: "POST",
      headers: { Authorization: `Bearer ${devToken.token}` },
      body: JSON.stringify({ argv: ["task", "done", task.id, "ready for review"] }),
    }),
    bindings,
  );

  await worker.fetch(
    new Request("https://gui/runtime/cli", {
      method: "POST",
      headers: { Authorization: `Bearer ${reviewerToken.token}` },
      body: JSON.stringify({ argv: ["task", "done", task.id, "approved"] }),
    }),
    bindings,
  );

  const afterReview = await json<{
    tasks: { id: string; assignee?: string; status: string }[];
    wakeLog?: { event: string; data: { agentId?: string; taskId?: string; agenda?: boolean } }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const doneTask = afterReview.tasks.find((row) => row.id === task.id);
  assert.equal(doneTask?.status, "done");
  assert.equal(doneTask?.assignee, "king-ai-ceo");
  assert.equal(
    afterReview.wakeLog?.some(
      (row) =>
        row.event === "wake" &&
        row.data.agentId === "king-ai-ceo" &&
        row.data.taskId === task.id &&
        row.data.agenda === true,
    ),
    true,
  );
});

test("wake filtering resolves implicit card wake targets before checking visibility", () => {
  const ctx = wakeResolveContextFromState({
    agents: [{ id: "king-ai-ceo" }, { id: "dev" }, { id: "reviewer" }],
    conversations: [
      {
        id: "king-ai-convo",
        coordinatorAgentId: "king-ai-ceo",
        teamMode: "team",
        kind: "group",
      },
    ],
    cards: [{ id: "card-1", title: "Stream target", column: "todo", assignee: "dev" }],
    tasks: [],
    defaultConversationId: "king-ai-convo",
    defaultCoordinatorAgentId: "king-ai-ceo",
  });
  const raw = { event: "wake", data: { agenda: true, cardId: "card-1" } };
  assert.equal(wakeEventVisibleToAgent(raw, "dev"), false);

  const resolved = resolveWakeEvent(ctx, raw);
  assert.deepEqual((resolved.data as { agentId?: string }).agentId, "dev");
  assert.equal(wakeEventVisibleToAgent(resolved, "dev"), true);
  assert.equal(wakeEventVisibleToAgent(resolved, "reviewer"), false);
});

test("new gui windows carry a collaboration team", async () => {
  const bindings = env();
  await pairComputer(bindings, { engines: ["codex"] });
  const defaultTeamAgentIds = ["king-ai-ceo", "dev", "reviewer"];
  const createdWindow = await json<{
    conversation: {
      id: string;
      coordinatorAgentId?: string;
      teamAgentIds?: string[];
      teamSnapshot?: { mode: string; teamAgentIds: string[]; agents: { id: string }[] };
    };
  }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "Feature Room", workflowId: "software-dev" }),
      }),
      bindings,
    ),
  );

  assert.equal(createdWindow.conversation.coordinatorAgentId, "king-ai-ceo");
  assert.deepEqual(createdWindow.conversation.teamAgentIds, defaultTeamAgentIds);
  assert.equal(createdWindow.conversation.teamSnapshot?.mode, "team");
  assert.deepEqual(
    createdWindow.conversation.teamSnapshot?.agents.map((agent) => agent.id),
    defaultTeamAgentIds,
  );

  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ conversationId: createdWindow.conversation.id, body: "窗口内协作一下" }),
    }),
    bindings,
  );

  const state = await json<{
    messages: { conversation_id: string; body: string; to_agent_id?: string }[];
    wakeLog?: { event: string; data: { conversationId?: string; agentId?: string } }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const message = state.messages.find(
    (row) => row.conversation_id === createdWindow.conversation.id && row.body === "窗口内协作一下",
  );
  assert.equal(message?.to_agent_id, "king-ai-ceo");
  assert.equal(
    state.wakeLog?.some(
      (row) =>
        row.event === "wake" &&
        row.data.conversationId === createdWindow.conversation.id &&
        row.data.agentId === "king-ai-ceo",
    ),
    true,
  );

  const summary = await json<{
    activeConversation?: { id: string; coordinatorAgentId?: string; teamAgentIds?: string[] };
    activeAgents: { id: string }[];
  }>(
    await worker.fetch(
      new Request(`https://gui/gui/summary?conversationId=${createdWindow.conversation.id}`),
      bindings,
    ),
  );
  assert.equal(summary.activeConversation?.id, createdWindow.conversation.id);
  assert.deepEqual(summary.activeConversation?.teamAgentIds, defaultTeamAgentIds);
  assert.deepEqual(
    summary.activeAgents.map((agent) => agent.id),
    defaultTeamAgentIds,
  );
});

test("gui messages endpoint returns one conversation and caches rendered markdown", async () => {
  const bindings = env();
  await pairComputer(bindings, { engines: ["codex"] });
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "hello from all", conversationId: "king-ai-convo" }),
    }),
    bindings,
  );
  const created = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "IELTS", workflowId: "ielts-study" }),
      }),
      bindings,
    ),
  );
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "hello from ielts", conversationId: created.conversation.id }),
    }),
    bindings,
  );

  const allMessages = await json<{
    conversationId: string;
    messages: { conversation_id: string; body: string; body_render_key?: string }[];
  }>(await worker.fetch(new Request("https://gui/gui/messages?conversationId=king-ai-convo"), bindings));
  assert.equal(allMessages.conversationId, "king-ai-convo");
  assert.ok(allMessages.messages.some((row) => row.body === "hello from all"));
  assert.equal(
    allMessages.messages.every((row) => row.conversation_id === "king-ai-convo"),
    true,
  );
  assert.ok(allMessages.messages.some((row) => row.body_render_key === "hello from all"));

  const ieltsMessages = await json<{ messages: { body: string; conversation_id: string }[] }>(
    await worker.fetch(new Request(`https://gui/gui/messages?conversationId=${created.conversation.id}`), bindings),
  );
  assert.ok(ieltsMessages.messages.length >= 1);
  assert.ok(ieltsMessages.messages.some((row) => row.body === "hello from ielts"));
  assert.equal(
    ieltsMessages.messages.every((row) => row.conversation_id === created.conversation.id),
    true,
  );

  const fullState = await json<{ messages: { conversation_id: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.ok(fullState.messages.length >= 2);
});

test("sortMessagesChronologically orders chat rows by created_at", async () => {
  const { sortMessagesChronologically } = await import("../src/gui-runtime.js");
  const ordered = sortMessagesChronologically([
    { id: "msg-ceo", conversation_id: "king-ai-convo", created_at: 3_000_000, body: "ceo" },
    { id: "msg-dev", conversation_id: "king-ai-convo", created_at: 2_000_000, body: "dev" },
    { id: "msg-human", conversation_id: "king-ai-convo", created_at: 1_000_000, body: "human" },
  ] as import("../src/gui-types.js").Message[]);
  assert.deepEqual(
    ordered.map((row) => row.id),
    ["msg-human", "msg-dev", "msg-ceo"],
  );
});

test("gui windows can choose single and custom collaboration teams", async () => {
  const bindings = env();
  await pairComputer(bindings, { engines: ["codex"] });
  const single = await json<{
    conversation: { id: string; teamMode?: string; coordinatorAgentId?: string; teamAgentIds?: string[] };
  }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({
          title: "Solo Room",
          workflowId: "software-dev",
          teamMode: "single",
          coordinatorAgentId: "dev",
        }),
      }),
      bindings,
    ),
  );
  assert.equal(single.conversation.teamMode, "single");
  assert.equal(single.conversation.coordinatorAgentId, "dev");
  assert.deepEqual(single.conversation.teamAgentIds, ["dev"]);

  const custom = await json<{
    conversation: {
      id: string;
      teamMode?: string;
      coordinatorAgentId?: string;
      teamAgentIds?: string[];
      teamSnapshot?: { agents: { id: string; role: string }[] };
    };
  }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({
          title: "Custom Room",
          workflowId: "software-dev",
          teamMode: "custom",
          coordinatorAgentId: "dev",
          teamAgentIds: ["reviewer"],
          agentRoles: { reviewer: "Review only this room." },
        }),
      }),
      bindings,
    ),
  );
  assert.equal(custom.conversation.teamMode, "custom");
  assert.equal(custom.conversation.coordinatorAgentId, "dev");
  assert.deepEqual(custom.conversation.teamAgentIds, ["dev", "reviewer"]);
  assert.equal(
    custom.conversation.teamSnapshot?.agents.find((agent) => agent.id === "reviewer")?.role,
    "Review only this room.",
  );

  const updateResponse = await worker.fetch(
    new Request(`https://gui/gui/conversations/${custom.conversation.id}/team`, {
      method: "POST",
      body: JSON.stringify({
        teamMode: "single",
        coordinatorAgentId: "reviewer",
        agentRoles: { dev: "Build the thing.", reviewer: "Review the thing." },
      }),
    }),
    bindings,
  );
  assert.equal(updateResponse.status, 409);
  const state = await json<{ agents: { id: string; role: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.notEqual(state.agents.find((agent) => agent.id === "dev")?.role, "Build the thing.");
  assert.notEqual(state.agents.find((agent) => agent.id === "reviewer")?.role, "Review the thing.");
});

test("gui windows choose agents from the selected workflow", async () => {
  const bindings = env();
  await pairComputer(bindings, { engines: ["codex"] });
  const summary = await json<{
    workflows: {
      id: string;
      defaultCoordinatorAgentId: string;
      agentIds: string[];
      agents: { id: string; name: string; role: string }[];
    }[];
  }>(await worker.fetch(new Request("https://gui/gui/summary"), bindings));
  const ieltsWorkflow = summary.workflows.find((workflow) => workflow.id === "ielts-study");
  assert.equal(ieltsWorkflow?.defaultCoordinatorAgentId, "ielts-tutor");
  assert.deepEqual(ieltsWorkflow?.agentIds, ["ielts-tutor"]);
  assert.equal(ieltsWorkflow?.agentIds.includes("king-ai-ceo"), false);
  assert.equal(ieltsWorkflow?.agents[0]?.name, "IELTS Reading & Writing Coach");
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /Keep the conversation in English/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /chat partner, not a translator/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /never translate or echo their own sentence back/);
  assert.match(
    ieltsWorkflow?.agents[0]?.role ?? "",
    /Only write a direct translation or a standalone piece of text when the learner explicitly asks/,
  );
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /Write that deliverable itself in English/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /Never give an empty acknowledgement/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /Use the hidden WordCards JSON to annotate English/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /The app automatically makes every single word clickable/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /do NOT wrap individual words yourself in the visible text/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /add one WordCards\.sentences entry/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /simple sentence usually has one clause/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /compound sentences have one clause per coordinated clause/);
  assert.match(
    ieltsWorkflow?.agents[0]?.role ?? "",
    /complex and compound-complex sentences include every main clause/,
  );
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /Every finite clause gets its own core/);
  assert.match(
    ieltsWorkflow?.agents[0]?.role ?? "",
    /continuous substring that actually appears word-for-word in that clause/,
  );
  assert.match(
    ieltsWorkflow?.agents[0]?.role ?? "",
    /Never rewrite, compress, reorder, or skip across words to create a new core/,
  );
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /use cores 'I have kept' and 'I hope'/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /use cores 'Your smile gives' and 'life feels'/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /the core is 'I want' and 'to eat' is a phrase/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /Each phrase is the shortest meaningful chunk/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /never create a WordCards\.sentences entry for the Tip line/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /Never mark a single word as a phrase/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /Never glue grammatically unrelated pieces together/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /Keep noun compounds whole/);
  assert.match(
    ieltsWorkflow?.agents[0]?.role ?? "",
    /Never wrap a whole clause, the sentence core, or most of a sentence in one phrase/,
  );
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /Every finite clause gets its own core/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /Explain the highlighted phrases in the same visible Tip line/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /after any natural-English expression for what the learner wrote/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /Do not rely on phrase click cards/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /End your reply with one hidden WordCards JSON block/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /"sentences"/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /"core":"life feels"/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /"token":"Your"/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /"meaningZh":"微笑"/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /Include every distinct English word token/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /Do not skip words because they are common/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /IPA phonetics wrapped in slashes/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /fill word cards and render core\/phrase highlights/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /Do not put prose inside WordCards/);
  assert.match(ieltsWorkflow?.agents[0]?.role ?? "", /Keep replies compact/);

  const single = await json<{
    conversation: {
      workflowId?: string;
      coordinatorAgentId?: string;
      teamAgentIds?: string[];
      teamSnapshot?: { workflowId: string; agents: { id: string }[] };
    };
  }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "IELTS Speaking", workflowId: "ielts-study", teamMode: "single" }),
      }),
      bindings,
    ),
  );
  assert.equal(single.conversation.workflowId, "ielts-study");
  assert.equal(single.conversation.coordinatorAgentId, "ielts-tutor");
  assert.deepEqual(single.conversation.teamAgentIds, ["ielts-tutor"]);
  assert.deepEqual(
    single.conversation.teamSnapshot?.agents.map((agent) => agent.id),
    ["ielts-tutor"],
  );

  const custom = await json<{
    conversation: {
      workflowId?: string;
      coordinatorAgentId?: string;
      teamAgentIds?: string[];
      teamSnapshot?: { agents: { id: string }[] };
    };
  }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({
          title: "IELTS Writing",
          workflowId: "ielts-study",
          teamMode: "custom",
          teamAgentIds: ["ielts-writing-coach", "dev"],
        }),
      }),
      bindings,
    ),
  );
  assert.equal(custom.conversation.coordinatorAgentId, "ielts-tutor");
  assert.deepEqual(custom.conversation.teamAgentIds, ["ielts-tutor"]);
  assert.equal(
    custom.conversation.teamSnapshot?.agents.some((agent) => agent.id === "king-ai-ceo"),
    false,
  );
  assert.equal(
    custom.conversation.teamSnapshot?.agents.some((agent) => agent.id === "dev"),
    false,
  );
  assert.equal(
    custom.conversation.teamSnapshot?.agents.some((agent) => agent.id === "ielts-writing-coach"),
    false,
  );
});

test("new gui windows default to the IELTS workflow", async () => {
  const bindings = env();
  await pairComputer(bindings, { engines: ["codex"] });
  const room = await json<{
    conversation: {
      workflowId?: string;
      coordinatorAgentId?: string;
      teamAgentIds?: string[];
      teamSnapshot?: { agents: { id: string }[] };
    };
  }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "Default Study Room", teamMode: "single" }),
      }),
      bindings,
    ),
  );

  assert.equal(room.conversation.workflowId, "ielts-study");
  assert.equal(room.conversation.coordinatorAgentId, "ielts-tutor");
  assert.deepEqual(room.conversation.teamAgentIds, ["ielts-tutor"]);
  assert.deepEqual(
    room.conversation.teamSnapshot?.agents.map((agent) => agent.id),
    ["ielts-tutor"],
  );
});

test("workflow agent membership stays within the fixed system roster", async () => {
  const bindings = env();
  await pairComputer(bindings, { engines: ["codex"] });
  const updated = await json<{ workflow: { id: string; agentIds: string[]; agents: { id: string; name: string }[] } }>(
    await worker.fetch(
      new Request("https://gui/gui/workflows/ielts-study/agents", {
        method: "POST",
        body: JSON.stringify({
          agents: [
            {
              id: "ielts-vocab-coach",
              name: "IELTS Vocabulary Coach",
              role: "Teach vocabulary with pronunciation and memory hooks.",
            },
          ],
          agentIds: ["ielts-tutor", "ielts-vocab-coach"],
        }),
      }),
      bindings,
    ),
  );
  assert.deepEqual(updated.workflow.agentIds, ["ielts-tutor"]);
  assert.equal(
    updated.workflow.agents.some((agent) => agent.id === "ielts-vocab-coach"),
    false,
  );

  const teamRoom = await json<{
    conversation: { workflowId?: string; teamAgentIds?: string[]; teamSnapshot?: { agents: { id: string }[] } };
  }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "Vocabulary Room", workflowId: "ielts-study", teamMode: "team" }),
      }),
      bindings,
    ),
  );
  assert.equal(teamRoom.conversation.workflowId, "ielts-study");
  assert.deepEqual(teamRoom.conversation.teamAgentIds, ["ielts-tutor"]);
  assert.deepEqual(
    teamRoom.conversation.teamSnapshot?.agents.map((agent) => agent.id),
    ["ielts-tutor"],
  );

  const removed = await json<{ workflow: { agentIds: string[] } }>(
    await worker.fetch(
      new Request("https://gui/gui/workflows/ielts-study/agents", {
        method: "POST",
        body: JSON.stringify({ agentIds: ["ielts-tutor"] }),
      }),
      bindings,
    ),
  );
  assert.deepEqual(removed.workflow.agentIds, ["ielts-tutor"]);

  const state = await json<{ agents: { id: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.deepEqual(
    state.agents.map((agent) => agent.id),
    ["king-ai-ceo", "dev", "reviewer", "ielts-tutor"],
  );

  const missing = await worker.fetch(
    new Request("https://gui/gui/workflows/missing-workflow/agents", {
      method: "POST",
      body: JSON.stringify({ agentIds: ["ielts-tutor"] }),
    }),
    bindings,
  );
  assert.equal(missing.status, 404);
});

test("single-agent gui windows keep requests with King AI CEO", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const devToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/dev/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const reviewerToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/reviewer/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const room = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "Solo Room", workflowId: "software-dev", teamMode: "single" }),
      }),
      bindings,
    ),
  );

  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ conversationId: room.conversation.id, body: "只让负责人处理" }),
    }),
    bindings,
  );

  const state = await json<{
    tasks: { conversationId?: string }[];
    messages: { conversation_id: string; to_agent_id?: string; body: string }[];
    wakeLog?: { event: string; data: { conversationId?: string; agentId?: string; agenda?: boolean } }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.equal(
    state.tasks.some((task) => task.conversationId === room.conversation.id),
    false,
  );
  assert.equal(
    state.messages.some((row) => row.conversation_id === room.conversation.id && row.to_agent_id === "dev"),
    false,
  );
  assert.equal(
    state.wakeLog?.some(
      (row) =>
        row.event === "wake" && row.data.conversationId === room.conversation.id && row.data.agentId === "king-ai-ceo",
    ),
    true,
  );
  assert.equal(
    state.wakeLog?.some(
      (row) => row.event === "wake" && row.data.conversationId === room.conversation.id && row.data.agentId === "dev",
    ),
    false,
  );

  const devInbox = await json<{ rows: { body: string }[] }>(
    await worker.fetch(
      new Request("https://gui/runtime/inbox", {
        headers: { Authorization: `Bearer ${devToken.token}` },
      }),
      bindings,
    ),
  );
  assert.deepEqual(devInbox.rows, []);
  const reviewerInbox = await json<{ rows: { body: string }[] }>(
    await worker.fetch(
      new Request("https://gui/runtime/inbox", {
        headers: { Authorization: `Bearer ${reviewerToken.token}` },
      }),
      bindings,
    ),
  );
  assert.deepEqual(reviewerInbox.rows, []);
});

test("casual team greetings stay with the coordinator without task handoff", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const ceoToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const devToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/dev/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );

  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "你好" }),
    }),
    bindings,
  );

  const state = await json<{
    tasks: { requestMessageId?: string }[];
    messages: { body: string; to_agent_id?: string; status?: string }[];
    wakeLog?: { event: string; data: { agentId?: string; taskId?: string; agenda?: boolean } }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.equal(state.tasks.length, 0);
  assert.equal(
    state.messages.some((row) => row.to_agent_id === "dev" && row.body.includes("Task assigned")),
    false,
  );
  assert.equal(
    state.wakeLog?.some(
      (row) => row.event === "wake" && row.data.agentId === "king-ai-ceo" && row.data.taskId === undefined,
    ),
    true,
  );
  assert.equal(
    state.wakeLog?.some((row) => row.event === "wake" && row.data.agentId === "dev" && row.data.agenda === true),
    false,
  );

  const ceoInbox = await json<{ rows: { body: string; to_agent_id?: string }[] }>(
    await worker.fetch(
      new Request("https://gui/runtime/inbox", {
        headers: { Authorization: `Bearer ${ceoToken.token}` },
      }),
      bindings,
    ),
  );
  assert.equal(
    ceoInbox.rows.some((row) => row.body === "你好" && row.to_agent_id === "king-ai-ceo"),
    true,
  );
  const devInbox = await json<{ rows: { body: string }[] }>(
    await worker.fetch(
      new Request("https://gui/runtime/inbox", {
        headers: { Authorization: `Bearer ${devToken.token}` },
      }),
      bindings,
    ),
  );
  assert.deepEqual(devInbox.rows, []);
});

test("team roll calls stay with the coordinator without task handoff", async () => {
  const bindings = env();
  await pairComputer(bindings, { engines: ["codex"] });
  const room = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "Roll Call Room", workflowId: "software-dev" }),
      }),
      bindings,
    ),
  );

  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ conversationId: room.conversation.id, body: "所有人在回个 1" }),
    }),
    bindings,
  );

  const state = await json<{
    tasks: { id: string; conversationId?: string; assignee?: string; reviewerAgentId?: string }[];
    messages: { conversation_id: string; to_agent_id?: string; body: string }[];
    wakeLog?: {
      event: string;
      data: { conversationId?: string; agentId?: string; taskId?: string; agenda?: boolean };
    }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const task = state.tasks.find((row) => row.conversationId === room.conversation.id);
  assert.equal(task, undefined);
  assert.equal(
    state.messages.some(
      (row) =>
        row.conversation_id === room.conversation.id && row.to_agent_id === "dev" && row.body.includes("Task assigned"),
    ),
    false,
  );
  assert.equal(
    state.messages.some(
      (row) =>
        row.conversation_id === room.conversation.id &&
        row.to_agent_id === "reviewer" &&
        row.body.includes("Task assigned"),
    ),
    false,
  );
  assert.equal(
    state.wakeLog?.some(
      (row) =>
        row.event === "wake" &&
        row.data.conversationId === room.conversation.id &&
        row.data.agentId === "king-ai-ceo" &&
        row.data.taskId === undefined,
    ),
    true,
  );
  assert.equal(
    state.wakeLog?.some(
      (row) =>
        row.event === "wake" &&
        row.data.conversationId === room.conversation.id &&
        row.data.agentId === "dev" &&
        row.data.agenda === true,
    ),
    false,
  );
});

test("custom gui windows can include dev without reviewer", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const devToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/dev/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const room = await json<{ conversation: { id: string; teamAgentIds?: string[] } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({
          title: "Dev Only Room",
          workflowId: "software-dev",
          teamMode: "custom",
          teamAgentIds: ["dev"],
        }),
      }),
      bindings,
    ),
  );
  assert.deepEqual(room.conversation.teamAgentIds, ["king-ai-ceo", "dev"]);

  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ conversationId: room.conversation.id, body: "让 dev 做但不评审" }),
    }),
    bindings,
  );

  const afterMessage = await json<{
    tasks: {
      id: string;
      status: string;
      assignee?: string;
      conversationId?: string;
      coordinatorAgentId?: string;
      reviewerAgentId?: string;
    }[];
    messages: { conversation_id: string; to_agent_id?: string; body: string }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const task = afterMessage.tasks.find((row) => row.conversationId === room.conversation.id);
  assert.equal(task?.status, "assigned");
  assert.equal(task?.assignee, "dev");
  assert.equal(task?.coordinatorAgentId, "king-ai-ceo");
  assert.equal(task?.reviewerAgentId, undefined);
  assert.equal(
    afterMessage.messages.some((row) => row.conversation_id === room.conversation.id && row.to_agent_id === "reviewer"),
    false,
  );

  const done = await json<{ text: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/cli", {
        method: "POST",
        headers: { Authorization: `Bearer ${devToken.token}` },
        body: JSON.stringify({ argv: ["task", "done", task?.id ?? "", "dev finished"] }),
      }),
      bindings,
    ),
  );
  assert.match(done.text, /returned to king-ai-ceo/);

  const afterDone = await json<{
    tasks: { id: string; status: string; assignee?: string; result?: string }[];
    messages: { conversation_id: string; author_name: string; to_agent_id?: string; body: string }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const doneTask = afterDone.tasks.find((row) => row.id === task?.id);
  assert.equal(doneTask?.status, "done");
  assert.equal(doneTask?.assignee, "king-ai-ceo");
  assert.equal(doneTask?.result, "dev finished");
  assert.equal(
    afterDone.messages.some(
      (row) =>
        row.conversation_id === room.conversation.id &&
        row.to_agent_id === "king-ai-ceo" &&
        row.author_name === "Dev" &&
        row.body.includes("Task completed"),
    ),
    true,
  );
  assert.equal(
    afterDone.messages.some((row) => row.conversation_id === room.conversation.id && row.to_agent_id === "reviewer"),
    false,
  );
});

test("single-agent workflow completion does not prompt a duplicate chat summary", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tutorToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/ielts-tutor/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const room = await json<{ conversation: { id: string; teamAgentIds?: string[] } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "IELTS Attendance", workflowId: "ielts-study", teamMode: "single" }),
      }),
      bindings,
    ),
  );
  assert.deepEqual(room.conversation.teamAgentIds, ["ielts-tutor"]);

  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ conversationId: room.conversation.id, body: "Everyone, reply with '1' if you're here." }),
    }),
    bindings,
  );

  const afterMessage = await json<{
    tasks: {
      id: string;
      status: string;
      assignee?: string;
      conversationId?: string;
      coordinatorAgentId?: string;
      reviewerAgentId?: string;
      acceptance?: string[];
    }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const task = afterMessage.tasks.find((row) => row.conversationId === room.conversation.id);
  assert.equal(task?.status, "assigned");
  assert.equal(task?.assignee, "ielts-tutor");
  assert.equal(task?.coordinatorAgentId, "ielts-tutor");
  assert.equal(task?.reviewerAgentId, undefined);
  assert.equal(
    task?.acceptance?.some((row) => /completion summary/i.test(row)),
    false,
  );

  await worker.fetch(
    new Request("https://gui/runtime/cli", {
      method: "POST",
      headers: { Authorization: `Bearer ${tutorToken.token}` },
      body: JSON.stringify({ argv: ["reply", room.conversation.id, "1"] }),
    }),
    bindings,
  );
  const done = await json<{ text: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/cli", {
        method: "POST",
        headers: { Authorization: `Bearer ${tutorToken.token}` },
        body: JSON.stringify({ argv: ["task", "done", task?.id ?? ""] }),
      }),
      bindings,
    ),
  );
  assert.match(done.text, /returned to ielts-tutor/);

  const afterDone = await json<{
    tasks: { id: string; status: string; assignee?: string }[];
    messages: { conversation_id: string; author_name: string; to_agent_id?: string; body: string }[];
    taskEvents: { taskId: string; type: string }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const doneTask = afterDone.tasks.find((row) => row.id === task?.id);
  assert.equal(doneTask?.status, "done");
  assert.equal(doneTask?.assignee, "ielts-tutor");
  assert.deepEqual(
    afterDone.messages
      .filter(
        (row) => row.conversation_id === room.conversation.id && row.author_name === "IELTS Reading & Writing Coach",
      )
      .map((row) => row.body),
    ["1"],
  );
  assert.equal(
    afterDone.messages.some(
      (row) =>
        row.conversation_id === room.conversation.id &&
        row.to_agent_id === "ielts-tutor" &&
        row.body.includes("Task completed"),
    ),
    false,
  );
  assert.equal(
    afterDone.taskEvents.some((row) => row.taskId === task?.id && row.type === "completed"),
    true,
  );
});

test("software-dev system roster contains only the fixed built-in agents", async () => {
  const bindings = env();
  await pairComputer(bindings, { engines: ["codex"] });
  const room = await json<{ conversation: { id: string; teamAgentIds?: string[] } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({
          title: "Research Room",
          workflowId: "software-dev",
          teamMode: "custom",
          teamAgentIds: ["dev", "reviewer", "researcher", "tester", "ops"],
        }),
      }),
      bindings,
    ),
  );
  assert.deepEqual(room.conversation.teamAgentIds, ["king-ai-ceo", "dev", "reviewer"]);

  const state = await json<{
    agents: { id: string }[];
    workflows: { id: string; agentIds: string[] }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.deepEqual(
    state.agents.map((agent) => agent.id),
    ["king-ai-ceo", "dev", "reviewer", "ielts-tutor"],
  );
});

test("gui window requests close the loop through dev, reviewer, and coordinator", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const devToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/dev/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const reviewerToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/reviewer/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const ceoToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const room = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "闭环房间", workflowId: "software-dev" }),
      }),
      bindings,
    ),
  );

  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ conversationId: room.conversation.id, body: "做一个闭环 demo" }),
    }),
    bindings,
  );

  const afterMessage = await json<{
    tasks: {
      id: string;
      status: string;
      assignee?: string;
      conversationId?: string;
      coordinatorAgentId?: string;
      reviewerAgentId?: string;
    }[];
    messages: { conversation_id: string; to_agent_id?: string; body: string; status?: string }[];
    taskEvents: { taskId: string; type: string; targetAgentId?: string }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const task = afterMessage.tasks.find((row) => row.conversationId === room.conversation.id);
  assert.equal(task?.status, "assigned");
  assert.equal(task?.assignee, "dev");
  assert.equal(task?.coordinatorAgentId, "king-ai-ceo");
  assert.equal(task?.reviewerAgentId, "reviewer");
  assert.equal(
    afterMessage.messages.some(
      (row) =>
        row.conversation_id === room.conversation.id && row.to_agent_id === "dev" && row.body.includes("Task assigned"),
    ),
    true,
  );
  assert.equal(
    afterMessage.taskEvents.some(
      (event) => event.taskId === task?.id && event.type === "assigned" && event.targetAgentId === "dev",
    ),
    true,
  );

  const callDev = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${devToken.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );
  const callReviewer = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${reviewerToken.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );
  const callCeo = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${ceoToken.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  assert.match((await callDev(["task", "done", task?.id ?? "", "dev result ready"])).text, /submitted for review/);
  const afterDev = await json<{
    tasks: { id: string; status: string; assignee?: string; result?: string }[];
    messages: { conversation_id: string; to_agent_id?: string; body: string }[];
    taskEvents: { taskId: string; type: string; targetAgentId?: string }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const reviewTask = afterDev.tasks.find((row) => row.id === task?.id);
  assert.equal(reviewTask?.status, "review");
  assert.equal(reviewTask?.assignee, "reviewer");
  assert.equal(reviewTask?.result, "dev result ready");
  assert.equal(
    afterDev.messages.some(
      (row) =>
        row.conversation_id === room.conversation.id &&
        row.to_agent_id === "reviewer" &&
        row.body.includes("Task assigned"),
    ),
    true,
  );
  assert.equal(
    afterDev.taskEvents.some(
      (event) =>
        event.taskId === task?.id && event.type === "submitted_for_review" && event.targetAgentId === "reviewer",
    ),
    true,
  );

  assert.match(
    (
      await callReviewer([
        "task",
        "done",
        task?.id ?? "",
        "--review",
        "approved",
        "--artifact",
        "state-machines-report.md",
      ])
    ).text,
    /returned to king-ai-ceo/,
  );
  const afterReview = await json<{
    tasks: {
      id: string;
      status: string;
      assignee?: string;
      result?: string;
      reviewResult?: string;
      artifactIds?: string[];
    }[];
    messages: { conversation_id: string; to_agent_id?: string; body: string }[];
    taskEvents: { taskId: string; type: string; reviewResult?: string; artifactIds?: string[] }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const doneTask = afterReview.tasks.find((row) => row.id === task?.id);
  assert.equal(doneTask?.status, "done");
  assert.equal(doneTask?.assignee, "king-ai-ceo");
  assert.equal(doneTask?.result, "dev result ready");
  assert.equal(doneTask?.reviewResult, "approved");
  assert.deepEqual(doneTask?.artifactIds, ["state-machines-report.md"]);
  assert.equal(
    afterReview.messages.some(
      (row) =>
        row.conversation_id === room.conversation.id &&
        row.to_agent_id === "king-ai-ceo" &&
        row.body.includes("Task completed"),
    ),
    true,
  );
  assert.equal(
    afterReview.taskEvents.some(
      (event) => event.taskId === task?.id && event.type === "completed" && event.reviewResult === "approved",
    ),
    true,
  );

  assert.match((await callCeo(["reply", room.conversation.id, "闭环已完成：review passed"])).text, /reply posted/);
  const finalState = await json<{
    messages: { conversation_id: string; author_name: string; body: string; status?: string }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.equal(
    finalState.messages.some(
      (row) =>
        row.conversation_id === room.conversation.id &&
        row.author_name === "King AI CEO" &&
        row.body.includes("闭环已完成"),
    ),
    true,
  );
});

test("reviewer can return a task with an explicit revision reason", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const reviewerToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/reviewer/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const task = await json<{ task: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/task", {
        method: "POST",
        body: JSON.stringify({ title: "需要返工", assignee: "reviewer" }),
      }),
      bindings,
    ),
  );

  const returned = await json<{ text: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/cli", {
        method: "POST",
        headers: { Authorization: `Bearer ${reviewerToken.token}` },
        body: JSON.stringify({
          argv: ["task", "done", task.task.id, "--review", "changes_requested", "--reason", "补测试覆盖"],
        }),
      }),
      bindings,
    ),
  );
  assert.match(returned.text, /returned to dev/);

  const state = await json<{
    tasks: { id: string; status: string; assignee?: string; reviewResult?: string; revisionReason?: string }[];
    taskEvents: { taskId: string; type: string; revisionReason?: string }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const updated = state.tasks.find((row) => row.id === task.task.id);
  assert.equal(updated?.status, "assigned");
  assert.equal(updated?.assignee, "dev");
  assert.equal(updated?.reviewResult, "changes_requested");
  assert.equal(updated?.revisionReason, "补测试覆盖");
  assert.equal(
    state.taskEvents.some(
      (event) =>
        event.taskId === task.task.id && event.type === "changes_requested" && event.revisionReason === "补测试覆盖",
    ),
    true,
  );
});

test("gui runtime clears messages without clearing paired engines", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["claude", "codex"] });
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "queued" }),
    }),
    bindings,
  );
  const token = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const auth = { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" };
  const run = await json<{ runId: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/runs", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          contract: { agentId: "king-ai-ceo", conversationId: "king-ai-convo", messageId: "msg-clear" },
        }),
      }),
      bindings,
    ),
  );
  await worker.fetch(
    new Request("https://gui/runtime/cli", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ runId: run.runId, argv: ["reply", "king-ai-convo", "done"] }),
    }),
    bindings,
  );

  await json<{ ok: true }>(
    await worker.fetch(
      new Request("https://gui/gui/clear-messages", {
        method: "POST",
      }),
      bindings,
    ),
  );

  const state = await json<{
    availableEngines: string[];
    messages: unknown[];
    cliLog: unknown[];
    runLog: unknown[];
    runStreams: Record<string, unknown>;
    activeRunContracts: Record<string, unknown>;
    runActions: Record<string, unknown>;
    runAttempts: Record<string, unknown>;
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.deepEqual(state.availableEngines, ["claude", "codex"]);
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.cliLog, []);
  assert.deepEqual(state.runLog, []);
  assert.deepEqual(state.runStreams, {});
  assert.deepEqual(state.activeRunContracts, {});
  assert.deepEqual(state.runActions, {});
  assert.deepEqual(state.runAttempts, {});
});

test("gui can clear only the active conversation window", async () => {
  const bindings = env();
  const created = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "事务窗口" }),
      }),
      bindings,
    ),
  );
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "default window" }),
    }),
    bindings,
  );
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "clear only me", conversationId: created.conversation.id }),
    }),
    bindings,
  );

  await json<{ ok: true; conversationId: string }>(
    await worker.fetch(
      new Request("https://gui/gui/clear-messages", {
        method: "POST",
        body: JSON.stringify({ conversationId: created.conversation.id }),
      }),
      bindings,
    ),
  );

  const state = await json<{ messages: { conversation_id: string; body: string; status?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.deepEqual(
    state.messages
      .filter((row) => !row.body.includes("Task assigned"))
      .map((row) => [row.conversation_id, row.body, row.status]),
    [
      ["king-ai-convo", "default window", undefined],
      ["king-ai-convo", "已委派给 dev 处理...", "pending"],
    ],
  );
});

test("gui supports multiple conversation windows", async () => {
  const bindings = env();
  const created = await json<{ conversation: { id: string; title: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "发布计划" }),
      }),
      bindings,
    ),
  );
  assert.equal(created.conversation.title, "发布计划");

  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "default window" }),
    }),
    bindings,
  );
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "release window", conversationId: created.conversation.id }),
    }),
    bindings,
  );

  const state = await json<{
    conversations: { id: string; title: string }[];
    messages: { conversation_id: string; body: string; status?: string }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.equal(
    state.conversations.some((row) => row.id === created.conversation.id && row.title === "发布计划"),
    true,
  );
  assert.deepEqual(
    state.messages
      .filter((row) => !row.body.includes("Task assigned"))
      .map((row) => [row.conversation_id, row.body, row.status]),
    [
      ["king-ai-convo", "default window", undefined],
      ["king-ai-convo", "已委派给 dev 处理...", "pending"],
      [created.conversation.id, "release window", undefined],
      [created.conversation.id, "AI 正在处理...", "pending"],
    ],
  );

  const summary = await json<{ conversations: { id: string; messages: number; unread: number }[] }>(
    await worker.fetch(new Request("https://gui/gui/summary"), bindings),
  );
  assert.equal(summary.conversations.find((row) => row.id === created.conversation.id)?.messages, 2);
  assert.equal(summary.conversations.find((row) => row.id === "king-ai-convo")?.messages, 2);
});

test("gui orders new conversation windows near the top", async () => {
  const bindings = env();
  const first = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "旧事务" }),
      }),
      bindings,
    ),
  );
  const latest = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "新事务" }),
      }),
      bindings,
    ),
  );

  const summary = await json<{ conversations: { id: string; title: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/summary"), bindings),
  );
  const orderedIds = summary.conversations.map((row) => row.id);
  assert.equal(orderedIds[0], "king-ai-convo");
  assert.equal(orderedIds.indexOf(latest.conversation.id) < orderedIds.indexOf(first.conversation.id), true);
});

test("gui can delete non-default conversation windows", async () => {
  const bindings = env();
  const created = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "临时窗口" }),
      }),
      bindings,
    ),
  );
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ conversationId: created.conversation.id, body: "delete me" }),
    }),
    bindings,
  );

  const deleted = await json<{ deleted: boolean }>(
    await worker.fetch(
      new Request(`https://gui/gui/conversations/${created.conversation.id}/delete`, { method: "POST" }),
      bindings,
    ),
  );
  assert.equal(deleted.deleted, true);

  const state = await json<{ conversations: { id: string }[]; messages: { conversation_id: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.equal(
    state.conversations.some((row) => row.id === created.conversation.id),
    false,
  );
  assert.equal(
    state.messages.some((row) => row.conversation_id === created.conversation.id),
    false,
  );
});

test("gui runtime exports, imports, and resets durable state snapshots", async () => {
  const bindings = env();
  await pairComputer(bindings, { engines: ["claude", "codex"] });
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "persist me" }),
    }),
    bindings,
  );

  const exported = await json<{ schema: string; state: { availableEngines: string[]; messages: { body: string }[] } }>(
    await worker.fetch(new Request("https://gui/gui/export-state"), bindings),
  );
  assert.equal(exported.schema, "king-ai.gui-state.v1");
  assert.deepEqual(exported.state.availableEngines, ["claude", "codex"]);
  assert.equal(exported.state.messages[0]?.body, "persist me");

  await json<{ ok: true }>(
    await worker.fetch(new Request("https://gui/gui/reset-state", { method: "POST" }), bindings),
  );
  const resetState = await json<{
    availableEngines: string[];
    messages: unknown[];
    runStreams: Record<string, unknown>;
    activeRunContracts: Record<string, unknown>;
    runAttempts: Record<string, unknown>;
    wakeLog?: { event: string; data: { resetState?: boolean } }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.deepEqual(resetState.availableEngines, []);
  assert.deepEqual(resetState.messages, []);
  assert.deepEqual(resetState.runStreams, {});
  assert.deepEqual(resetState.activeRunContracts, {});
  assert.deepEqual(resetState.runAttempts, {});
  assert.equal(
    resetState.wakeLog?.some((row) => row.event === "wake" && row.data.resetState === true),
    true,
  );

  await json<{ ok: true; messages: number }>(
    await worker.fetch(
      new Request("https://gui/gui/import-state", {
        method: "POST",
        body: JSON.stringify(exported),
      }),
      bindings,
    ),
  );
  const imported = await json<{ availableEngines: string[]; messages: { body: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.deepEqual(imported.availableEngines, ["claude", "codex"]);
  assert.equal(imported.messages[0]?.body, "persist me");

  const bad = await worker.fetch(
    new Request("https://gui/gui/import-state", {
      method: "POST",
      body: JSON.stringify({ schema: "bad", state: {} }),
    }),
    bindings,
  );
  assert.equal(bad.status, 400);
});

test("gui king-ai state command exports, imports, and resets state snapshots", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "cli snapshot" }),
    }),
    bindings,
  );
  const snapshotText = (await callCli(["state", "export"])).text;
  assert.match(snapshotText, /king-ai\.gui-state\.v1/);

  assert.match((await callCli(["state", "reset"])).text, /"ok":true|"ok": true/);
  assert.match((await callCli(["state", "import", snapshotText])).text, /"messages":3|"messages": 3/);
  const state = await json<{ messages: { body: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.equal(state.messages[0]?.body, "cli snapshot");
});

test("gui runtime lets the page choose agent engine and models", async () => {
  const oldGrace = process.env.KING_AI_RUNTIME_TOKEN_INVALIDATION_GRACE_MS;
  process.env.KING_AI_RUNTIME_TOKEN_INVALIDATION_GRACE_MS = "0";
  try {
    const bindings = env();
    const paired = await pairComputer(bindings, { engines: ["claude", "codex"] });
    const beforeToken = await json<{ token: string }>(
      await worker.fetch(
        new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
          method: "POST",
          headers: { Authorization: `Bearer ${paired.deviceToken}` },
        }),
        bindings,
      ),
    );

    await json<{ ok: true }>(
      await worker.fetch(
        new Request("https://gui/gui/agent-config", {
          method: "POST",
          body: JSON.stringify({
            name: "King AI Helper",
            role: "Answer in a concise operator voice.",
            engine: "claude",
            lifecycle: "disabled",
            model: "opus-test",
            fastModel: "haiku-test",
            reasoningEffort: "low",
          }),
        }),
        bindings,
      ),
    );

    const agents = await json<
      {
        name?: string;
        role?: string;
        engine?: string;
        lifecycle?: string;
        model?: string;
        fastModel?: string;
        reasoningEffort?: string;
      }[]
    >(
      await worker.fetch(
        new Request("https://gui/api/computers/me/agents", {
          headers: { Authorization: `Bearer ${paired.deviceToken}` },
        }),
        bindings,
      ),
    );
    assert.equal(agents[0]?.name, "King AI Helper");
    assert.equal(agents[0]?.role, "Answer in a concise operator voice.");
    assert.equal(agents[0]?.engine, "claude");
    assert.equal(agents[0]?.lifecycle, "disabled");
    assert.equal(agents[0]?.model, "opus-test");
    assert.equal(agents[0]?.fastModel, "haiku-test");
    assert.equal(agents[0]?.reasoningEffort, "low");
    // Runtime settings apply to the whole team, not just the coordinator agent.
    assert.ok(agents.length > 1);
    for (const agent of agents) {
      assert.equal(agent.engine, "claude");
      assert.equal(agent.lifecycle, "disabled");
      assert.equal(agent.model, "opus-test");
      assert.equal(agent.fastModel, "haiku-test");
      assert.equal(agent.reasoningEffort, "low");
    }
    // Name / role stay specific to the coordinator agent.
    assert.notEqual(agents[1]?.name, "King AI Helper");
    assert.notEqual(agents[1]?.role, "Answer in a concise operator voice.");

    const state = await json<{
      agentConfigUpdatedAt?: number;
      wakeLog?: { event?: string; data?: { config?: boolean } }[];
    }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
    assert.equal(typeof state.agentConfigUpdatedAt, "number");
    // A config change pushes a config event so connected runners re-sync immediately.
    assert.ok((state.wakeLog ?? []).some((entry) => entry.event === "config" && entry.data?.config === true));

    const oldTokenStatus = await worker.fetch(
      new Request("https://gui/runtime/cli", {
        method: "POST",
        headers: { Authorization: `Bearer ${beforeToken.token}` },
        body: JSON.stringify({ argv: ["reply", "king-ai-convo", "stale response"] }),
      }),
      bindings,
    );
    assert.equal(oldTokenStatus.status, 401);

    const afterToken = await json<{ token: string }>(
      await worker.fetch(
        new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
          method: "POST",
          headers: { Authorization: `Bearer ${paired.deviceToken}` },
        }),
        bindings,
      ),
    );
    assert.notEqual(afterToken.token, beforeToken.token);
  } finally {
    if (oldGrace === undefined) delete process.env.KING_AI_RUNTIME_TOKEN_INVALIDATION_GRACE_MS;
    else process.env.KING_AI_RUNTIME_TOKEN_INVALIDATION_GRACE_MS = oldGrace;
  }
});

test("gui runtime rejects expired runtime tokens server-side", async () => {
  const bindings = env({
    deviceToken: "device-token",
    runtimeTokens: { "king-ai-ceo": "expired-token" },
    runtimeTokenMeta: { "king-ai-ceo": { token: "expired-token", expiresAt: Date.now() - 1000 } },
  });
  const expired = await worker.fetch(
    new Request("https://gui/runtime/cli", {
      method: "POST",
      headers: { Authorization: "Bearer expired-token" },
      body: JSON.stringify({ argv: ["whoami"] }),
    }),
    bindings,
  );
  assert.equal(expired.status, 401);

  const fresh = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: "Bearer device-token" },
      }),
      bindings,
    ),
  );
  const ok = await worker.fetch(
    new Request("https://gui/runtime/cli", {
      method: "POST",
      headers: { Authorization: `Bearer ${fresh.token}` },
      body: JSON.stringify({ argv: ["whoami"] }),
    }),
    bindings,
  );
  assert.equal(ok.status, 200);
});

test("gui messages show a pending agent placeholder until runtime reply replaces it", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["claude", "codex"] });
  const token = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );

  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "please implement the feature" }),
    }),
    bindings,
  );

  let state = await json<{
    messages: { author_kind: string; author_engine?: string; body: string; status?: string }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.deepEqual(
    state.messages
      .filter((row) => row.author_kind !== "system")
      .map((row) => [row.author_kind, row.author_engine, row.body, row.status]),
    [
      ["human", undefined, "please implement the feature", undefined],
      ["agent", "grok", "已委派给 dev 处理...", "pending"],
    ],
  );

  await json<{ text: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/cli", {
        method: "POST",
        headers: { Authorization: `Bearer ${token.token}` },
        body: JSON.stringify({ agentId: "king-ai-ceo", engine: "claude", argv: ["reply", "king-ai-convo", "done"] }),
      }),
      bindings,
    ),
  );

  state = await json<{ messages: { author_kind: string; author_engine?: string; body: string; status?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.deepEqual(
    state.messages
      .filter((row) => row.author_kind !== "system")
      .map((row) => [row.author_kind, row.author_engine, row.body, row.status]),
    [
      ["human", undefined, "please implement the feature", undefined],
      ["agent", "claude", "done", "done"],
    ],
  );
});

test("runtime reply rejects unknown conversations instead of creating ghost windows", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const token = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const rejected = await json<{ exitCode: number; text: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/cli", {
        method: "POST",
        headers: { Authorization: `Bearer ${token.token}` },
        body: JSON.stringify({ argv: ["reply", "typo-convo", "hello"] }),
      }),
      bindings,
    ),
  );

  assert.equal(rejected.exitCode, 64);
  assert.match(rejected.text, /conversation not found: typo-convo/);
  const state = await json<{ conversations: { id: string }[]; messages: { body: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.equal(
    state.conversations.some((conversation) => conversation.id === "typo-convo"),
    false,
  );
  assert.equal(
    state.messages.some((message) => message.body === "hello"),
    false,
  );
});

test("runtime replies only replace pending placeholders for the executing agent", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const ceoToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const devToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/dev/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );

  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "please coordinate" }),
    }),
    bindings,
  );

  await json<{ text: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/cli", {
        method: "POST",
        headers: { Authorization: `Bearer ${devToken.token}` },
        body: JSON.stringify({ agentId: "dev", argv: ["reply", "king-ai-convo", "dev status"] }),
      }),
      bindings,
    ),
  );

  let state = await json<{
    messages: {
      author_name: string;
      author_kind: string;
      author_agent_id?: string;
      body: string;
      status?: string;
      to_agent_id?: string;
    }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.deepEqual(
    state.messages
      .filter((row) => row.author_kind !== "system")
      .map((row) => [row.author_name, row.author_agent_id, row.body, row.status, row.to_agent_id]),
    [
      ["King AI Human", undefined, "please coordinate", undefined, "king-ai-ceo"],
      ["King AI CEO", "king-ai-ceo", "已委派给 dev 处理...", "pending", "king-ai-ceo"],
      ["Dev", "dev", "dev status", "done", undefined],
    ],
  );

  await json<{ text: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/cli", {
        method: "POST",
        headers: { Authorization: `Bearer ${ceoToken.token}` },
        body: JSON.stringify({ agentId: "king-ai-ceo", argv: ["reply", "king-ai-convo", "ceo close"] }),
      }),
      bindings,
    ),
  );

  state = await json<{
    messages: {
      author_name: string;
      author_kind: string;
      author_agent_id?: string;
      body: string;
      status?: string;
      to_agent_id?: string;
    }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.deepEqual(
    state.messages
      .filter((row) => row.author_kind !== "system")
      .map((row) => [row.author_name, row.author_agent_id, row.body, row.status, row.to_agent_id]),
    [
      ["King AI Human", undefined, "please coordinate", undefined, "king-ai-ceo"],
      ["King AI CEO", "king-ai-ceo", "ceo close", "done", undefined],
      ["Dev", "dev", "dev status", "done", undefined],
    ],
  );
});

test("runtime replies use the executing agent display name", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["claude"] });
  await json<{ ok: true }>(
    await worker.fetch(
      new Request("https://gui/gui/agent-config", {
        method: "POST",
        body: JSON.stringify({ name: "Claude Runner", engine: "claude" }),
      }),
      bindings,
    ),
  );
  const token = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );

  await json<{ text: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/cli", {
        method: "POST",
        headers: { Authorization: `Bearer ${token.token}` },
        body: JSON.stringify({ agentId: "king-ai-ceo", engine: "codex", argv: ["reply", "king-ai-convo", "hello"] }),
      }),
      bindings,
    ),
  );

  const state = await json<{
    messages: {
      author_name: string;
      author_kind: string;
      author_agent_id?: string;
      author_engine?: string;
      body: string;
    }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.deepEqual(
    state.messages.map((row) => [row.author_name, row.author_kind, row.author_agent_id, row.author_engine, row.body]),
    [["Claude Runner", "agent", "king-ai-ceo", "codex", "hello"]],
  );
});

test("runtime CLI side effects default to the executing agent identity", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const devToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/dev/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const callDev = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${devToken.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  assert.match((await callDev(["send", "reviewer", "please review"])).text, /queued -> reviewer/);
  assert.match((await callDev(["claim", "dev-claim", "--in", "king-ai-convo"])).text, /claim created/);
  assert.match(
    (
      await callDev([
        "artifact",
        "put",
        "--kind",
        "market_data",
        "--path",
        "runtime/actor",
        "--source",
        "test",
        "--confidence",
        "0.9",
      ])
    ).text,
    /artifact stored/,
  );

  const state = await json<{
    messages: { author_name: string; readBy: string[]; to_agent_id?: string; body: string }[];
    claims: { owner: string; name: string }[];
    artifacts: { agentId: string; path: string }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.equal(
    state.messages.some(
      (message) =>
        message.to_agent_id === "reviewer" && message.author_name === "Dev" && message.readBy.includes("dev"),
    ),
    true,
  );
  assert.equal(
    state.claims.some((claim) => claim.name === "dev-claim" && claim.owner === "dev"),
    true,
  );
  assert.equal(
    state.artifacts.some((artifact) => artifact.path === "runtime/actor" && artifact.agentId === "dev"),
    true,
  );
});

test("runtime reply engine prefers the active run engine over stale shim payloads", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["claude", "codex"] });
  const token = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );

  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "which engine" }),
    }),
    bindings,
  );
  await worker.fetch(
    new Request("https://gui/runtime/runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ trigger: { source: "wake", engine: "claude" } }),
    }),
    bindings,
  );
  await json<{ text: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/cli", {
        method: "POST",
        headers: { Authorization: `Bearer ${token.token}` },
        body: JSON.stringify({
          agentId: "king-ai-ceo",
          engine: "codex",
          argv: ["reply", "king-ai-convo", "from claude"],
        }),
      }),
      bindings,
    ),
  );

  const state = await json<{ messages: { author_engine?: string; body: string; status?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.deepEqual(
    state.messages
      .filter((row) => !row.body.includes("Task assigned"))
      .map((row) => [row.author_engine, row.body, row.status]),
    [
      [undefined, "which engine", undefined],
      ["claude", "from claude", "done"],
    ],
  );
});

test("runtime replies fall back to the default agent for unknown agent ids", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["claude"] });
  const token = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );

  await json<{ text: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/cli", {
        method: "POST",
        headers: { Authorization: `Bearer ${token.token}` },
        body: JSON.stringify({ agentId: "missing-agent", argv: ["reply", "king-ai-convo", "hello"] }),
      }),
      bindings,
    ),
  );

  const state = await json<{ messages: { author_name: string; author_engine?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.equal(state.messages[0]?.author_name, "King AI CEO");
  assert.equal(state.messages[0]?.author_engine, "grok");
});

test("gui runtime records computer capabilities from pair and heartbeat", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, {
    engines: ["codex"],
    capabilities: { workspaces: ["/Users/fayon/workspace/github"], agentWorkspaceRoot: "/tmp/agents" },
  });

  const state = await json<{ capabilities: { workspaces: string[]; agentWorkspaceRoot?: string } }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.deepEqual(state.capabilities.workspaces, ["/Users/fayon/workspace/github"]);
  assert.equal(state.capabilities.agentWorkspaceRoot, "/tmp/agents");

  await json<{ ok: true }>(
    await worker.fetch(
      new Request("https://gui/api/computers/heartbeat", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
        body: JSON.stringify({
          version: "0.1.0",
          capabilities: { workspaces: ["/tmp/project"], agentWorkspaceRoot: "/tmp/runtime-agents" },
        }),
      }),
      bindings,
    ),
  );

  const heartbeatState = await json<{
    capabilities: { workspaces: string[]; agentWorkspaceRoot?: string };
    lastHeartbeat?: { version?: string };
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.deepEqual(heartbeatState.capabilities.workspaces, ["/tmp/project"]);
  assert.equal(heartbeatState.capabilities.agentWorkspaceRoot, "/tmp/runtime-agents");
  assert.equal(heartbeatState.lastHeartbeat?.version, "0.1.0");
});

test("gui runtime requires the generated pairing code", async () => {
  const bindings = env();
  const summary = await json<{ pairingCode: string }>(
    await worker.fetch(new Request("https://gui/gui/summary"), bindings),
  );
  assert.match(summary.pairingCode, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  const invalid = await worker.fetch(
    new Request("https://gui/api/computers/pair", {
      method: "POST",
      body: JSON.stringify({ code: "gui", engines: ["codex"] }),
    }),
    bindings,
  );
  assert.equal(invalid.status, 401);

  await pairComputer(bindings, { engines: ["codex"] });
  const reused = await worker.fetch(
    new Request("https://gui/api/computers/pair", {
      method: "POST",
      body: JSON.stringify({ code: summary.pairingCode, engines: ["claude"] }),
    }),
    bindings,
  );
  assert.equal(reused.status, 401);
  const state = await json<{ availableEngines: string[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.deepEqual(state.availableEngines, ["codex"]);
});

test("gui runtime pairing does not rewrite entity state", async () => {
  const bindings = env(undefined, { KING_AI_TEST_FAIL_STORAGE_PUT_AFTER: { "state:messages": 1 } });
  const summary = await json<{ pairingCode: string }>(
    await worker.fetch(new Request("https://gui/gui/summary"), bindings),
  );

  const paired = await worker.fetch(
    new Request("https://gui/api/computers/pair", {
      method: "POST",
      body: JSON.stringify({
        code: summary.pairingCode,
        hostName: "test-host",
        engines: ["codex"],
        version: "0.2.18",
        capabilities: { workspaces: ["/tmp/project"] },
      }),
    }),
    bindings,
  );

  assert.equal(paired.status, 200);
  const state = await json<{ availableEngines: string[]; capabilities: { workspaces: string[] } }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.deepEqual(state.availableEngines, ["codex"]);
  assert.deepEqual(state.capabilities.workspaces, ["/tmp/project"]);
});

test("gui page exposes channel chat shell with settings modal", async () => {
  const page = await worker.fetch(new Request("https://gui/"), env());
  const html = await page.text();
  assert.match(html, /King AI Chat/);
  assert.match(html, /Channels/);
  assert.match(html, /# all/);
  assert.match(html, /id="chatWindow"/);
  assert.match(html, /id="settingsDialog"/);
  assert.match(html, /\.main\s*\{[\s\S]*grid-template-rows:\s*auto auto auto minmax\(0, 1fr\)/);
  assert.match(html, /function currentHumanName/);
  assert.match(html, /function displayInitial/);
  assert.match(html, /displayInitial\(message\.author_name \|\| 'AI', 'A'\)/);
  assert.match(html, /id="computerDialog"/);
  assert.match(html, /id="newWindowDialog"/);
  assert.match(html, /id="newWindowTitle"/);
  assert.match(html, /id="newWindowWorkflow"/);
  assert.match(html, /name="newWindowMode"/);
  assert.doesNotMatch(html, /id="newWindowOwner"/);
  assert.match(html, /id="newWindowTeam"/);
  assert.doesNotMatch(html, /id="newWindowRolePrompts"/);
  assert.doesNotMatch(html, /function selectedAgentRoles/);
  assert.doesNotMatch(html, /function rolePromptAgentsForMode/);
  assert.doesNotMatch(html, /data-agent-role-id/);
  assert.doesNotMatch(html, /onchange="renderRolePrompts\(\)"/);
  assert.match(html, /const fixed = agent\.id === coordinatorId/);
  assert.match(html, /const checked = fixed \? ' checked' : ''/);
  assert.doesNotMatch(html, /function defaultTeamAgentIdsForUi/);
  assert.match(html, /\.agent-check\s*\{[\s\S]*color:\s*var\(--ink\)/);
  assert.match(html, /\.agent-check input\s*\{[\s\S]*width:\s*16px/);
  assert.match(html, /function syncNewWindowMode/);
  assert.match(html, /sendMessage = async function/);
  assert.match(html, /pendingAttachments = \[\][\s\S]{0,80}renderAttachmentTray\(\)/);
  assert.match(html, /renderAttachmentTray\(\)[\s\S]{0,700}uploadAttachmentFiles/);
  assert.match(html, /addOptimisticMessages\(optimisticBody, optimisticAttachments\)/);
  assert.match(html, /function submitConversation/);
  assert.match(html, /function sortMessagesChronologically/);
  assert.match(html, /function applyNewConversationOptimistic/);
  assert.match(html, /applyNewConversationOptimistic\(result\.conversation\)/);
  assert.match(html, /function applyDeleteConversationOptimistic/);
  assert.match(html, /applyDeleteConversationOptimistic\(id\)/);
  assert.doesNotMatch(html, /submitConversation[\s\S]{0,900}await refresh\(\)/);
  assert.doesNotMatch(html, /prompt\('Window name'\)/);
  assert.match(html, /function openSettings/);
  assert.match(html, /function openComputerFlow/);
  assert.match(html, /grid-template-columns:\s*180px minmax\(0, 1fr\)/);
  assert.match(html, /class="windows"/);
  assert.doesNotMatch(html, /class="rail"/);
  assert.match(html, /windows: '窗口'/);
  assert.match(html, /allWindow: '全部'/);
  assert.match(html, /function displayConversationTitle/);
  assert.match(html, /renderConversations = function/);
  assert.match(html, /id="conversationList"/);
  assert.match(html, /\.window-select:hover[\s\S]*background:\s*transparent/);
  assert.match(html, /\.window-item\.active,\s*\n\s*\.window-item\.active:hover[\s\S]*background:\s*var\(--active\)/);
  assert.match(html, /window-list[\s\S]*display:\s*flex/);
  assert.match(html, /overflow-x:\s*auto/);
  assert.match(html, /mobile-layout/);
  assert.match(html, /body\.mobile-layout \.app[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.doesNotMatch(html, /body\.mobile-layout \.rail/);
  assert.match(html, /matchMedia\('\(max-width:\s*820px\)'\)/);
  assert.match(html, /window-delete/);
  assert.match(html, /function deleteConversation/);
  assert.match(html, /id="clearButton"/);
  assert.match(html, /function clearMessages/);
  assert.match(html, /renderMessages = function/);
  assert.match(html, /function playMessageTts/);
  assert.match(html, /const ttsAudioCache = new Map/);
  assert.match(html, /let activeTts = null/);
  assert.match(html, /let loadingTtsId = ''/);
  assert.match(html, /function showTtsNotice/);
  assert.match(html, /function stopActiveTts/);
  assert.match(html, /function playTts/);
  assert.match(html, /function isIeltsTutorMessage/);
  assert.match(html, /author_agent_id === 'ielts-tutor'/);
  assert.match(html, /function ttsTextFromIeltsMessage/);
  assert.match(html, /WordCards/);
  assert.match(html, /Useful phrases/);
  assert.match(html, /\/gui\/tts/);
  assert.match(html, /class="icon-btn tts-button"/);
  assert.match(html, /data-tts-state="idle"/);
  assert.match(html, /\.tts-notice/);
  assert.match(html, /@keyframes tts-spin/);
  assert.match(html, /\.post-body\.markdown-body/);
  assert.match(html, /const renderedBody = message\.body_html \|\| ''/);
  assert.match(html, /renderedBody \|\| escapeHtml\(message\.body\)/);
  assert.match(html, /'post-body markdown-body'/);
  assert.match(html, /\.ielts-core/);
  assert.match(html, /\.ielts-phrase/);
  assert.match(html, /\.ielts-word/);
  assert.match(html, /border-bottom:\s*1px dotted/);
  assert.match(html, /id="vocabDialog"/);
  assert.match(html, /id="vocabAudioButton"/);
  assert.match(html, /function playVocabTts/);
  assert.match(html, /vocabAudio/);
  assert.match(html, /function openVocabDialog/);
  assert.match(html, /target\.closest\('\.ielts-word'\)/);
  assert.match(html, /vocabNoDetails/);
  assert.match(html, /closest\('\.vocab-row'\)\.hidden = !hasDetails/);
  assert.match(html, /data-i18n="vocabMeaning"|vocabMeaning:/);
  assert.match(html, /\.message-list\.empty-state\s*\{[\s\S]*position:\s*sticky/);
  // Outgoing user messages render optimistically before the network round trip.
  assert.match(html, /function addOptimisticMessages/);
  assert.match(html, /function reconcileOptimistic/);
  assert.match(html, /const batchId = addOptimisticMessages\(optimisticBody, optimisticAttachments\)/);
  assert.match(html, /__awaitingImagePreload/);
  assert.match(html, /await preloadAttachmentImages\(imageAttachments\)/);
  assert.match(html, /await readImageDimensions\(row\.url\)/);
  assert.match(html, /attachmentPreviewFrameStyle\(attachment\)/);
  assert.match(html, /attachmentPreviewShimmer/);
  // The "agent thinking" placeholder is no longer shown — pending bubbles are filtered out.
  assert.match(html, /function shouldRenderChatMessage/);
  assert.match(html, /if \(message\.status === 'pending'\) return false/);
  assert.match(html, /const visibleRows = rows\.filter\(shouldRenderChatMessage\)/);
  // Composer run indicator: a labeled dot that pulses while the room is busy and is static when idle.
  assert.match(html, /id="runIndicator"/);
  assert.match(html, /id="runLabel"/);
  assert.match(html, /runIndicator\.classList\.toggle\('running', busy\)/);
  assert.match(html, /if \(runLabel\) runLabel\.textContent = label/);
  assert.match(html, /@keyframes kingRunPulse/);
  assert.match(html, /\.task-board\s*\{[\s\S]*display:\s*grid/);
  assert.match(html, /\.task-board\s*\{[\s\S]*overflow-x:\s*hidden/);
  assert.match(
    html,
    /#panel-tasks\.tab-panel,[\s\S]*#panel-files\.tab-panel,[\s\S]*#panel-decisions\.tab-panel\s*\{[\s\S]*width:\s*100%/,
  );
  assert.match(
    html,
    /#panel-tasks\.tab-panel,[\s\S]*#panel-files\.tab-panel,[\s\S]*#panel-decisions\.tab-panel\s*\{[\s\S]*max-width:\s*none/,
  );
  assert.match(html, /body\.mobile-layout \.team-strip\s*\{[\s\S]*overflow-x:\s*auto/);
  assert.match(html, /body\.mobile-layout \.team-strip\s*\{[\s\S]*flex-wrap:\s*nowrap/);
  assert.match(html, /\.task-grid\s*\{[\s\S]*repeat\(auto-fill, minmax\(min\(300px, 100%\), 1fr\)\)/);
  assert.match(html, /\.task-card\s*\{[\s\S]*display:\s*flex/);
  assert.match(html, /\.task-card\s*\{[\s\S]*flex-direction:\s*column/);
  assert.match(html, /\.task-card\s*\{[\s\S]*min-height:\s*122px/);
  assert.match(html, /\.task-card-action\s*\{[\s\S]*flex:\s*1 1 auto/);
  assert.match(html, /\.task-card-footer\s*\{[\s\S]*margin-top:\s*auto/);
  assert.match(html, /body\.mobile-layout \.task-card\s*\{[\s\S]*min-height:\s*0/);
  assert.match(html, /body\.mobile-layout \.task-card p\s*\{[\s\S]*-webkit-line-clamp:\s*2/);
  assert.match(html, /let taskFilterMode = localStorage\.getItem\('king-ai:taskFilter'\)/);
  assert.match(html, /function setTaskFilter\(mode\)/);
  assert.match(html, /function taskMatchesFilter\(task\)/);
  assert.match(html, /function isLowSignalTaskText\(value, task\)/);
  assert.match(html, /\^Handle the human request in/);
  assert.match(html, /function taskCardHtml\(task\)/);
  assert.match(html, /id="taskChatDialog"/);
  assert.match(html, /class="task-chat-dialog"/);
  assert.match(html, /function openTaskChat\(taskId\)/);
  assert.match(html, /function closeTaskChat\(\)/);
  assert.match(html, /function taskChatRows\(task\)/);
  assert.match(html, /const request = task\.requestMessageId \? allRows\.find/);
  assert.match(html, /const nextRequestAt = request \? \(allRows\.find/);
  assert.match(html, /message\.created_at < request\.created_at/);
  assert.match(html, /message\.created_at >= nextRequestAt/);
  assert.match(html, /shouldRenderChatMessage\(message\)/);
  assert.match(html, /function taskChatMessageHtml\(message\)/);
  assert.match(html, /function taskChatAuthorName\(message\)/);
  assert.match(html, /function taskChatInitial\(message, author\)/);
  assert.match(html, /task-chat-body \.message-list/);
  assert.match(html, /'<article class="post"><div class="avatar">'/);
  assert.doesNotMatch(html, /task-chat-message/);
  assert.doesNotMatch(html, /task-chat-content/);
  assert.match(html, /onclick="openTaskChat\(&quot;'/);
  assert.match(html, /taskOpenChat: '查看聊天'/);
  assert.match(html, /taskOpenChat: 'View chat'/);
  assert.match(html, /function latestTaskEvent\(task\)/);
  assert.match(html, /message\.payload && message\.payload\.taskEventType/);
  assert.match(html, /renderTasks = function\(state\)/);
  assert.match(html, /function isAllConversationView\(\)/);
  assert.match(html, /function taskMatchesConversation\(task\)/);
  assert.match(html, /function derivedRequestTasks\(state, existingTasks\)/);
  assert.match(html, /const nextRequestAt = \(\(state\.messages \|\| \[\]\)\.find/);
  assert.match(html, /const hasAgentReply = \(state\.messages \|\| \[\]\)\.some/);
  assert.match(html, /!nextRequestAt \|\| row\.created_at < nextRequestAt/);
  assert.match(html, /status: hasAgentReply \? 'done' : 'in_progress'/);
  assert.match(html, /id: 'request-' \+ message\.id/);
  assert.match(html, /function visibleTasksForState\(state\)/);
  assert.match(html, /visibleTasksForState\(state\)\.find\(function\(row\) \{ return row\.id === taskId; \}\)/);
  assert.match(html, /function artifactMatchesConversation\(artifact, tasksById\)/);
  assert.match(html, /artifact\.taskId/);
  assert.match(html, /function attachmentFilesForState\(state\)/);
  assert.match(html, /message\.attachments \|\| \[\]/);
  assert.match(html, /function fileCardHtml\(file\)/);
  assert.match(html, /'<div class="task-card-action">'/);
  assert.match(html, /'<div class="task-card-footer">' \+ open \+ '<\/div>'/);
  assert.match(html, /target="_blank" rel="noreferrer noopener"/);
  assert.match(html, /function approvalMatchesConversation\(approval, tasksById\)/);
  assert.match(html, /approvalConversationId\(approval\)/);
  assert.match(html, /approvalTaskId\(approval\)/);
  assert.match(html, /function hostDecisionCardsFromResult\(hostResult\)/);
  assert.match(html, /const hostCards = isAllConversationView\(\) \? hostDecisionCardsFromResult\(hostResult\) : \[\]/);
  assert.match(html, /function workflowCardViewStatus\(status\)/);
  assert.match(html, /Array\.isArray\(state\.workflowCards\)/);
  assert.match(html, /taskFilterActive: '进行中'/);
  assert.match(html, /taskStatusInProgress: 'In progress'/);
  assert.match(html, /class="task-filter"/);
  assert.match(html, /taskFilterButton\('active', t\('taskFilterActive'\)\)/);
  assert.match(html, /onclick="setTaskFilter\(&quot;' \+ mode \+ '&quot;\)"/);
  assert.match(html, /loadOlder: '向上滚动加载更早消息\.\.\.'/);
  assert.match(html, /noOlderMessages: '没有更早消息'/);
  assert.match(html, /const olderLine = hasOlder \? t\('loadOlder'\) : t\('noOlderMessages'\)/);
  assert.match(html, /chatWindow\.classList\.toggle\('empty-state', !visibleRows\.length\)/);
  assert.match(html, /if \(!visibleRows\.length\) \{[\s\S]*workspace\.scrollTop = 0/);
  assert.match(html, /shouldStickToBottom && visibleRows\.length/);
  assert.match(html, /applyLanguage\(\);\s*refresh\(\);/);
  assert.match(html, /class="engine-chip"/);
  assert.match(html, /message\.author_engine/);
  assert.doesNotMatch(html, /<span class="author">AI<\/span><span class="time">now<\/span>/);
  assert.match(html, /等待本地 agent 回复/);
  assert.match(html, /agent 正在处理/);
  assert.match(html, /typing-dots/);
  assert.match(html, /second:\s*'2-digit'/);
  assert.match(html, /height:\s*100vh/);
  assert.match(html, /body\s*\{[\s\S]*overflow:\s*hidden/);
  assert.match(html, /dialog\[open\]\s*\{[\s\S]*display:\s*flex[\s\S]*overflow:\s*hidden/);
  assert.match(html, /dialog\[open\]\s*>\s*\.modal-body[\s\S]*overflow-y:\s*auto/);
  assert.match(html, /dialog\[open\]\s*>\s*\.computer-flow[\s\S]*overflow-y:\s*auto/);
  assert.doesNotMatch(html, /aria-label="King"><span>K<\/span><\/div>/);
  assert.doesNotMatch(html, /<span>I<\/span><span>N<\/span><span>G<\/span>/);
  assert.match(html, /Model status/);
  assert.doesNotMatch(html, /Agent persona/);
  assert.doesNotMatch(html, /Agent 人设/);
  assert.doesNotMatch(html, /id="agentName"/);
  assert.doesNotMatch(html, /id="agentRole"/);
  assert.match(html, /id="modelStatus"/);
  assert.match(html, /Message #all/);
  assert.doesNotMatch(html, /agent 电脑怎么弄/);
  assert.match(html, /id="sendButton"/);
  assert.match(html, /#sendButton[\s\S]*align-self:\s*end/);
  assert.match(html, /#sendButton[\s\S]*height:\s*54px/);
  assert.doesNotMatch(html, /button\.textContent = t\('sending'\)/);
  assert.match(html, /function refreshSoon/);
  assert.match(html, /button\.textContent = t\('send'\);[\s\S]*refreshSoon\(\)/);
  assert.doesNotMatch(html, /<span class="author">AI<\/span><span class="time">soon<\/span>/);
  assert.doesNotMatch(html, /已唤醒，等待本地 Claude\/Codex 回复/);
  assert.match(html, /Add a Computer/);
  assert.match(html, /Your Computer/);
  assert.match(html, /Connect Computer/);
  assert.match(html, /First-time pairing/);
  assert.match(html, /Already paired/);
  assert.match(html, /Claude Code or Codex CLI/);
  assert.match(html, /Claude Code 或 Codex CLI/);
  assert.doesNotMatch(html, /Kimi CLI/);
  assert.doesNotMatch(html, /Copilot CLI/);
  assert.doesNotMatch(html, /Cursor CLI/);
  assert.doesNotMatch(html, /Gemini CLI/);
  assert.doesNotMatch(html, /OpenCode/);
  assert.match(html, /Waiting for computer to connect/);
  assert.match(html, /Waiting for it to come online/);
  assert.match(html, /Apply/);
  assert.match(html, /Remote Assist/);
  assert.match(html, /const REMOTE_ASSIST_URL_KEY = 'king-ai:remoteAssistUrl'/);
  assert.match(html, /function copyRemoteAssistLink/);
  assert.match(html, /function remoteAssistUrlMatchesGrant/);
  assert.match(html, /token\.slice\(0, 8\) \+ '\.\.\.' \+ token\.slice\(-4\)/);
  assert.match(html, /remoteAssistUrlMatchesGrant\(remoteAssistUrl, grant\)/);
  assert.match(html, /copyButton\.disabled = !remoteAssistUrl/);
  assert.match(html, /setRemoteAssistUrl\(result\.url \|\| ''\)/);
  assert.match(html, /id="copyAssistButton"/);
  assert.doesNotMatch(html, /onclick="copyText\(remoteAssistUrl, this\)"/);
  assert.match(html, /id="resetAccountButton"/);
  assert.match(html, /class="side-card danger-card"/);
  assert.match(html, /function resetCurrentAccountData\(\)/);
  assert.match(html, /await request\('\/gui\/reset-state', \{ method: 'POST' \}\)/);
  assert.match(html, /dataResetTitle: '重新开始'/);
  assert.match(html, /dataResetButton: '还原初始状态'/);
  assert.match(html, /清理所有 agent 上下文、会话和 workspace/);
  assert.match(html, /dataResetConfirm: '再次点击确认清除'/);
  assert.match(html, /dataResetTitle: 'Start over'/);
  assert.match(html, /Restore initial state/);
  assert.match(html, /clear every agent context, session, and workspace/);
  assert.match(html, /localStorage\.removeItem\('king-ai:addComputerDismissed'\)/);
  assert.match(html, /Add computer/);
  assert.match(html, /\/gui\/summary/);
  assert.match(html, /showPanel\((?:'|&#39;)tasks(?:'|&#39;)\)/);
  assert.match(html, /function updateBackToBottom/);
  assert.match(html, /summary\.pairingCode/);
  assert.match(html, /summary\.pairingLocator/);
  // assert.match(html, /id="teamStrip"/); // team strip hidden
  assert.match(html, /class="team-agent"/);
  assert.match(html, /function renderTeamStrip/);
  assert.match(html, /function teamActivityTitle/);
  assert.match(html, /function currentRoomAgents/);
  assert.match(html, /function teamStatusText/);
  assert.match(html, /agentStatusThinking: '思考中'/);
  assert.match(html, /agentStatusUnread: '未读'/);
  assert.match(html, /agentStatusIdle: '空闲'/);
  assert.match(html, /agentStatusAvailable: '可用'/);
  assert.match(html, /agentStatusThinking: 'Thinking'/);
  assert.match(html, /agentStatusUnread: 'Unread'/);
  assert.match(html, /agentStatusAvailable: 'Available'/);
  assert.match(html, /return t\('agentStatusThinking'\)/);
  assert.match(html, /return t\('agentStatusUnread'\)/);
  assert.match(html, /function translatedAgentStatus/);
  assert.match(html, /value === 'avail' \|\| value === 'available' \|\| value === 'online' \|\| value === 'ready'/);
  assert.doesNotMatch(html, /\.team-status\s*\{[\s\S]*text-transform:\s*uppercase/);
  assert.match(html, /findAgentByName\(summary, message\.author_name\)/);
  assert.match(html, /message\.conversation_id !== activeConversationId \|\| message\.author_kind !== 'agent'/);
  assert.match(html, /class="team-status"/);
  assert.match(html, /\.team-dot\.active\s*\{\s*background:\s*#5c9f96/);
  assert.match(html, /ownerRole=/);
  assert.match(html, /reviewerRole=/);
  assert.match(html, /blockedBy=/);
  assert.match(html, /acceptance/);
  assert.match(html, /class="composer-tools"/);
  assert.match(
    html,
    /class="composer-tools"[\s\S]*data-i18n="backToBottom"[\s\S]*data-i18n="attachFile"[\s\S]*data-i18n="clearScreen"/,
  );
  assert.doesNotMatch(html, /<button onclick="refresh\(\)" data-i18n="refresh">Refresh<\/button>/);
  assert.match(html, /backToBottom: '↓ 回到底部'/);
  assert.match(html, /backToBottom: '↓ Back to bottom'/);
  assert.match(html, /\.composer-tools[\s\S]*position:\s*absolute/);
  assert.match(html, /\.composer-tools[\s\S]*bottom:\s*calc\(100% \+ 10px\)/);
  assert.match(html, /\.composer-tools[\s\S]*background:\s*var\(--canvas\)/);
  assert.match(html, /\.composer-tools \.jump[\s\S]*position:\s*static/);
  assert.match(html, /\.composer-tools \.jump\.visible[\s\S]*display:\s*inline-flex/);
  assert.match(html, /function syncComposerHeight\(\)/);
  assert.doesNotMatch(html, /--king-visual-height/);
  assert.doesNotMatch(html, /function mobileKeyboardInset\(\)/);
  assert.doesNotMatch(html, /function syncMobileViewport\(\)/);
  assert.match(html, /--king-composer-height/);
  assert.match(html, /--king-composer-bottom/);
  assert.doesNotMatch(html, /MOBILE_COMPOSER_BOTTOM_OPEN/);
  assert.match(html, /function setComposerKeyboardOpen\(/);
  assert.match(html, /keyboard-open/);
  assert.match(html, /interactive-widget=overlays-content/);
  assert.match(html, /MOBILE_VIEWPORT_FOCUSED/);
  assert.match(html, /maximum-scale=1/);
  assert.match(html, /function onComposerFocus\(\)/);
  assert.match(html, /@media \(max-width: 820px\)[\s\S]*#body[\s\S]*font-size:\s*16px/);
  assert.match(html, /autocomplete="off"/);
  assert.match(html, /enterKeyHint="send"/);
  assert.match(html, /scheduleComposerHeightSync/);
  assert.match(html, /scheduleMobileViewportRestore/);
  assert.match(html, /function restoreMobileChatViewport\(\)/);
  assert.match(html, /function resetMobilePageScroll\(\)/);
  assert.doesNotMatch(html, /window\.visualViewport\.addEventListener\('resize', syncMobileViewport\)/);
  assert.match(html, /body\.mobile-layout \.app[\s\S]*height:\s*100dvh/);
  assert.match(html, /body\.mobile-layout \.main[\s\S]*height:\s*auto/);
  assert.match(
    html,
    /body\.mobile-layout \.chat-panel[\s\S]*padding:\s*10px 0 calc\(var\(--king-composer-height, 126px\) \+ 24px\)/,
  );
  assert.match(
    html,
    /body\.mobile-layout \.composer[\s\S]*bottom:\s*max\(var\(--king-composer-bottom, 16px\), env\(safe-area-inset-bottom, 0px\)\)/,
  );
  assert.match(html, /body\.mobile-layout\.keyboard-open \.composer[\s\S]*position:\s*static/);
  assert.match(html, /body\.mobile-layout\.keyboard-open \.composer[\s\S]*bottom:\s*auto/);
  assert.match(html, /body\.mobile-layout \.composer[\s\S]*grid-template-areas/);
  assert.match(html, /body\.mobile-layout #sendButton[\s\S]*min-width:\s*68px/);
  assert.match(html, /body\.mobile-layout #sendButton[\s\S]*height:\s*54px/);
  assert.match(html, /body\.mobile-layout \.composer-tools\s*\{[^}]*position:\s*static/);
  assert.match(html, /body\.mobile-layout \.composer-tools\s*\{[^}]*grid-area:\s*tools/);
  assert.match(
    html,
    /body\.mobile-layout \.composer-tools\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/,
  );
  assert.match(html, /body\.mobile-layout \.composer-tools \.run-indicator\s*\{[^}]*grid-column:\s*1 \/ -1/);
  assert.match(html, /body\.mobile-layout \.composer-tools \.jump\.visible\s*\{[^}]*grid-column:\s*1 \/ -1/);
  assert.match(html, /body\.mobile-layout \.composer-tools button\s*\{[^}]*width:\s*100%/);
  assert.doesNotMatch(html, /let shouldStickToBottom = true;[\s\S]*let shouldStickToBottom = true;/);
  assert.match(html, /activeConversationStatus = function/);
  assert.doesNotMatch(html, /defaultTeamDesc: '7 个 agent'/);
  assert.doesNotMatch(html, /defaultTeamDesc: '7 agents'/);
  assert.match(html, /function agentCountLabel/);
  assert.match(html, /function syncNewWindowModeOptions/);
  assert.match(html, /const teamAvailable = agents\.length > 1/);
  assert.match(html, /teamInput\.disabled = !teamAvailable/);
  assert.match(html, /customInput\.disabled = !teamAvailable/);
  assert.match(html, /teamOption\.classList\.toggle\('hidden', !teamAvailable\)/);
  assert.match(html, /customOption\.classList\.toggle\('hidden', !teamAvailable\)/);
  assert.match(html, /teamDesc\.textContent = agentCountLabel\(agents\.length\)/);
  assert.match(html, /data-window-mode-option="team"/);
  assert.doesNotMatch(html, /单 Agent：/);
  assert.doesNotMatch(html, /默认团队：/);
  assert.doesNotMatch(html, /自定义团队：/);
  assert.doesNotMatch(html, /Default team:/);
  assert.doesNotMatch(html, /data-i18n="channelDesc"/);
  assert.match(html, /summary\.agents/);
  assert.match(html, /summary\.activeAgents/);
  assert.doesNotMatch(html, /onclick="editActiveConversationTeam\(\)"/);
  assert.match(html, /\/gui\/summary\?conversationId=/);
  assert.doesNotMatch(html, /request\('\/gui\/summary'\)/);
  assert.match(html, /npx -y @suwujs\/king-ai@latest/);
  assert.match(html, /agent computer --pair/);
  assert.match(html, /pairCommandStart = npxKingAiCommand\('agent computer'\)/);
  assert.doesNotMatch(html, /Computer pairing/);
  assert.doesNotMatch(html, /--pair gui/);
  assert.doesNotMatch(html, /id="state"/);
  assert.doesNotMatch(html, /King 本地 Agent 控制台/);
});

test("gui tts endpoint runs Workers AI grok tts", async () => {
  const calls: Array<{ model: string; input: Record<string, unknown>; options?: Record<string, unknown> }> = [];
  const bindings = env(undefined, {
    CLOUDFLARE_AI_GATEWAY_ID: "default",
    AI: {
      async run(model: string, input: Record<string, unknown>, options?: Record<string, unknown>) {
        calls.push({ model, input, options });
        return new Uint8Array([1, 2, 3]);
      },
    },
  });
  const res = await worker.fetch(
    new Request("https://gui/gui/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello! Welcome to IELTS practice.", language: "en" }),
    }),
    bindings,
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") || "", /audio\/mpeg/);
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3]);
  assert.deepEqual(calls, [
    {
      model: "xai/grok-tts",
      input: { text: "Hello! Welcome to IELTS practice.", language: "en" },
      options: { gateway: { id: "default" } },
    },
  ]);
});

test("gui tts endpoint requires explicit opt-in for Cloudflare AI REST fallback", async () => {
  const bindings = env(undefined, {
    CLOUDFLARE_ACCOUNT_ID: "account-123",
    CLOUDFLARE_AI_API_TOKEN: "token-123",
    CLOUDFLARE_AI_GATEWAY_ID: "default",
  });
  const res = await worker.fetch(
    new Request("https://gui/gui/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Please read this IELTS answer.", language: "en" }),
    }),
    bindings,
  );
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as { error?: string }).error, "workers_ai_not_configured");
});

test("gui tts endpoint can fall back to Cloudflare AI run REST gateway when enabled", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; auth: string; gateway: string; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      auth: request.headers.get("Authorization") || "",
      gateway: request.headers.get("cf-aig-gateway-id") || "",
      body: await request.json(),
    });
    return new Response(new Uint8Array([4, 5, 6]), { headers: { "Content-Type": "audio/mpeg" } });
  }) as typeof fetch;
  try {
    const bindings = env(undefined, {
      CLOUDFLARE_ACCOUNT_ID: "account-123",
      CLOUDFLARE_AI_API_TOKEN: "token-123",
      CLOUDFLARE_AI_GATEWAY_ID: "default",
      CLOUDFLARE_AI_REST_FALLBACK: "1",
    });
    const res = await worker.fetch(
      new Request("https://gui/gui/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Please read this IELTS answer.", language: "en" }),
      }),
      bindings,
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") || "", /audio\/mpeg/);
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [4, 5, 6]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/account-123/ai/run");
    assert.equal(calls[0].auth, "Bearer token-123");
    assert.equal(calls[0].gateway, "default");
    assert.deepEqual(calls[0].body, {
      model: "xai/grok-tts",
      input: { text: "Please read this IELTS answer.", language: "en" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gui ui summary and activity endpoints aggregate console state", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"], capabilities: { workspaces: ["/tmp/project"] } });
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "inspect this" }),
    }),
    bindings,
  );
  await worker.fetch(
    new Request("https://gui/gui/task", {
      method: "POST",
      body: JSON.stringify({
        title: "Console task",
        description: "verify summary",
        paths: "apps/gui-worker/src/index.ts",
      }),
    }),
    bindings,
  );
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  await worker.fetch(
    new Request("https://gui/runtime/notices", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        noticeKind: "byoa_engine_failed",
        text: "King AI CEO could not run on local codex: usage limit reached\nCodex quota or billing limit is blocking runs.",
      }),
    }),
    bindings,
  );

  const summary = await json<{
    connection: { paired: boolean };
    availableEngines: string[];
    observation: { classification: string; counts: { unreadMessages: number; activeTasks: number } };
    routeSummary: string;
  }>(await worker.fetch(new Request("https://gui/gui/summary"), bindings));
  assert.equal(summary.connection.paired, true);
  assert.deepEqual(summary.availableEngines, ["codex"]);
  assert.equal(summary.observation.classification, "backlog_stuck");
  assert.equal(summary.observation.counts.unreadMessages, 1);
  assert.equal(summary.observation.counts.activeTasks, 2);
  assert.match(summary.routeSummary, /respond\/normal\/msg/);

  const activity = await json<{ rows: { type: string; summary: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/activity?limit=10"), bindings),
  );
  assert.ok(activity.rows.some((row) => row.type === "message.human" && row.summary.includes("inspect this")));
  assert.ok(activity.rows.some((row) => row.type === "runtime.notice" && row.summary.includes("usage limit reached")));
  assert.ok(activity.rows.some((row) => row.type === "queue.backlog"));
});

test("gui ui can update tasks, move cards, and mark a conversation read", async () => {
  const bindings = env();
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "read me" }),
    }),
    bindings,
  );
  const createdTask = await json<{ task: { id: string; status: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/task", {
        method: "POST",
        body: JSON.stringify({ title: "Move task", wake: false }),
      }),
      bindings,
    ),
  );
  assert.equal(createdTask.task.status, "assigned");

  const updatedTask = await json<{ task: { status: string } }>(
    await worker.fetch(
      new Request(`https://gui/gui/task/${createdTask.task.id}/update`, {
        method: "POST",
        body: JSON.stringify({ status: "done", result: "ok" }),
      }),
      bindings,
    ),
  );
  assert.equal(updatedTask.task.status, "done");

  const createdCard = await json<{ card: { id: string; column: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/card", {
        method: "POST",
        body: JSON.stringify({ title: "Move card", allowedPaths: ["apps/gui-worker"] }),
      }),
      bindings,
    ),
  );
  const movedCard = await json<{ card: { column: string } }>(
    await worker.fetch(
      new Request(`https://gui/gui/card/${createdCard.card.id}/move`, {
        method: "POST",
        body: JSON.stringify({ column: "doing" }),
      }),
      bindings,
    ),
  );
  assert.equal(movedCard.card.column, "doing");

  await json<{ ok: true }>(
    await worker.fetch(
      new Request("https://gui/gui/conversation/mark-read", {
        method: "POST",
        body: JSON.stringify({ conversationId: "king-ai-convo" }),
      }),
      bindings,
    ),
  );
  const summary = await json<{ observation: { counts: { unreadMessages: number } } }>(
    await worker.fetch(new Request("https://gui/gui/summary"), bindings),
  );
  assert.equal(summary.observation.counts.unreadMessages, 0);
});

test("gui runtime supports broader king-ai CLI commands", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["claude", "codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "hello" }),
    }),
    bindings,
  );

  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  assert.match((await callCli(["messages", "king-ai-convo"])).text, /hello/);
  assert.match((await callCli(["messages", "king-ai-convo", "--tail", "1"])).text, /hello/);
  assert.match((await callCli(["glance", "king-ai-convo"])).text, /King AI Human: hello/);
  assert.match((await callCli(["agents"])).text, /Agent Matrix:/);
  assert.match((await callCli(["agents"])).text, /king-ai-ceo\s+idle\s+on-demand\s+grok/);
  assert.match((await callCli(["agents", "spawn", "king-ai-ceo", "king-ai-ceo-2"])).text, /not supported/);
  assert.match(
    (await callCli(["roster"])).text,
    /king-ai-ceo\tKing AI CEO\tCoordinate the conversation: clarify ambiguous human requests/,
  );
  assert.match((await callCli(["roster"])).text, /engine=grok\tlifecycle=on-demand\tstatus=idle/);
  assert.match((await callCli(["participants"])).text, /unread=1/);
  assert.match((await callCli(["contacts", "operator"])).text, /gui-human\tKing AI Human\thuman\tRuntime operator/);
  assert.match((await callCli(["whoami"])).text, /"status": "idle"/);
  assert.match((await callCli(["status"])).text, /"agentState"/);
  assert.match((await callCli(["status"])).text, /availableEngines/);
  assert.match((await callCli(["help"])).text, /king-ai contacts/);
  assert.match((await callCli(["help"])).text, /king-ai agents \[spawn\|destroy\]/);
  assert.match((await callCli(["help"])).text, /king-ai card list\|create\|claim\|move\|done\|release/);
  assert.match((await callCli(["help"])).text, /--paths a,b/);
  assert.match((await callCli(["help"])).text, /king-ai initiative create\|list\|get\|update\|advance\|persist/);
  assert.match((await callCli(["help"])).text, /king-ai initiative advance <id>/);
  assert.match((await callCli(["help"])).text, /king-ai capsule create\|list\|mine\|get\|update/);
  assert.match((await callCli(["help"])).text, /king-ai send <agentId> <message>/);
  assert.match((await callCli(["help"])).text, /king-ai recv \[--agent agent-id\]/);
  assert.match((await callCli(["help"])).text, /king-ai escalate <message>/);
  assert.match((await callCli(["help"])).text, /king-ai observe \[--json\]/);
  assert.match((await callCli(["help"])).text, /king-ai context get\|set\|list\|delete/);
  assert.match((await callCli(["help"])).text, /king-ai hypothesis create\|list\|update/);
});

test("gui runtime supports send, recv, and escalate message relay commands", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  assert.match(
    (await callCli(["send", "teammate", "please", "review", "--type", "decision", "--steer"])).text,
    /queued -> teammate \(decision, steer\)/,
  );
  const firstRecv = await callCli(["recv", "--agent", "teammate"]);
  assert.match(firstRecv.text, /\[steer\/steer\/decision\] King AI CEO .*please review/);
  assert.match((await callCli(["recv", "--agent", "teammate"])).text, /No pending messages/);

  assert.match(
    (await callCli(["send", "teammate", "blocked", "on", "API", "--type", "blocker"])).text,
    /queued -> teammate \(blocker, normal\)/,
  );
  assert.match(
    (await callCli(["recv", "--agent", "teammate"])).text,
    /\[steer\/urgent\/blocker\] King AI CEO .*blocked on API/,
  );

  assert.match((await callCli(["dm", "teammate", "private", "note"])).text, /dm posted dm-king-ai-ceo-teammate/);
  assert.match((await callCli(["recv", "--agent", "other-agent"])).text, /No pending messages/);
  assert.match(
    (await callCli(["recv", "--agent", "teammate"])).text,
    /\[steer\/normal\/msg\] King AI CEO .*private note/,
  );

  assert.match(
    (await callCli(["escalate", "need", "human", "choice"])).text,
    /Escalated to king-ai-ceo: msg-.*\(queued\)/,
  );
  assert.match((await callCli(["recv"])).text, /\[steer\/steer\/decision\] King AI CEO .*need human choice/);

  assert.match(
    (await callCli(["send", "teammate", "normal", "followup"])).text,
    /queued -> teammate \(message, normal\)/,
  );
  assert.match(
    (await callCli(["send", "teammate", "urgent", "blocker", "--type", "blocker"])).text,
    /queued -> teammate \(blocker, normal\)/,
  );
  const priorityRecv = await callCli(["recv", "--agent", "teammate"]);
  assert.match(priorityRecv.text, /^\[steer\/urgent\/blocker\].*urgent blocker/m);
  assert.match(priorityRecv.text, /\[steer\/normal\/msg\].*normal followup/);

  const state = await json<{
    messages: { body: string; priority?: string; message_type?: string; to_agent_id?: string; readBy: string[] }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.equal(
    state.messages.some(
      (row) =>
        row.body === "please review" &&
        row.priority === "steer" &&
        row.message_type === "decision" &&
        row.to_agent_id === "teammate" &&
        row.readBy.includes("teammate"),
    ),
    true,
  );
});

test("gui runtime routes external events to subscribed agents", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const auth = { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" };
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  assert.match(
    (await callCli(["route", "set", "github_issue", "--agent", "reviewer"])).text,
    /route set github_issue -> reviewer/,
  );
  assert.match(
    (await callCli(["route", "set", "shared_event", "--agent", "reviewer"])).text,
    /route set shared_event -> reviewer/,
  );
  assert.match(
    (await callCli(["route", "set", "shared_event", "--agent", "dev"])).text,
    /route set shared_event -> dev/,
  );
  assert.match(
    (await callCli(["route", "set", "external_event", "--agent", "feedback"])).text,
    /unknown agent: feedback/,
  );
  assert.match((await callCli(["route", "list"])).text, /github_issue\t-> reviewer/);

  assert.match(
    (await callCli(["route", "emit", "github_issue", "--source", "github", '{"title":"Login broken"}'])).text,
    /event routed github_issue -> reviewer/,
  );
  assert.match(
    (await callCli(["recv", "--agent", "reviewer"])).text,
    /\[steer\/normal\/msg\] Runtime Event .*github_issue.*Login broken/,
  );
  assert.match((await callCli(["recv", "--agent", "dev"])).text, /No pending messages/);

  assert.match(
    (await callCli(["route", "emit", "shared_event", "--source", "test", '{"data":"broadcast"}'])).text,
    /event routed shared_event -> (dev,reviewer|reviewer,dev)/,
  );
  assert.match((await callCli(["recv", "--agent", "reviewer"])).text, /shared_event.*broadcast/);
  assert.match((await callCli(["recv", "--agent", "dev"])).text, /shared_event.*broadcast/);
  assert.match(
    (await callCli(["route", "emit", "unknown_event", "--source", "test", "{}"])).text,
    /event ignored unknown_event/,
  );

  const eventRes = await json<{ routed: string[] }>(
    await worker.fetch(
      new Request("https://gui/runtime/events", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ type: "github_issue", source: "github", payload: { title: "Billing broken" } }),
      }),
      bindings,
    ),
  );
  assert.deepEqual(eventRes.routed, ["reviewer"]);
  assert.match((await callCli(["recv", "--agent", "reviewer"])).text, /Billing broken/);

  const state = await json<{
    eventRoutes: { eventType: string; agentId: string }[];
    agents: { id: string; events?: string[] }[];
    messages: { to_agent_id?: string; payload?: { type?: string; payload?: { title?: string } } }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.deepEqual(
    state.agents.map((agent) => agent.id),
    ["king-ai-ceo", "dev", "reviewer", "ielts-tutor"],
  );
  assert.deepEqual(state.eventRoutes.map((route) => `${route.eventType}->${route.agentId}`).sort(), [
    "github_issue->reviewer",
    "shared_event->dev",
    "shared_event->reviewer",
  ]);
  assert.deepEqual(state.agents.find((agent) => agent.id === "reviewer")?.events?.sort(), [
    "github_issue",
    "shared_event",
  ]);
  assert.equal(
    state.messages.some(
      (message) =>
        message.to_agent_id === "reviewer" &&
        message.payload?.type === "github_issue" &&
        message.payload.payload?.title === "Billing broken",
    ),
    true,
  );
  assert.match(
    (await callCli(["route", "delete", "github_issue", "--agent", "reviewer"])).text,
    /route deleted github_issue -> reviewer/,
  );
});

test("gui runtime records status, typing, thinking, events, and runs", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["claude"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const auth = { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" };

  await worker.fetch(
    new Request("https://gui/runtime/status", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        status: "thinking",
        remediation: {
          engine: "claude",
          category: "quota",
          severity: "error",
          summary: "claude quota or billing limit is blocking runs",
          detail: "You've hit your session limit",
          actions: ["Open claude locally and refresh quota.", "Re-run: king-ai agent computer --doctor"],
        },
      }),
    }),
    bindings,
  );
  await worker.fetch(
    new Request("https://gui/runtime/typing", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ conversationId: "king-ai-convo", done: false }),
    }),
    bindings,
  );
  await worker.fetch(
    new Request("https://gui/runtime/thinking/mark", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ conversationIds: ["king-ai-convo"] }),
    }),
    bindings,
  );
  await worker.fetch(
    new Request("https://gui/runtime/events", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ kind: "gui.event" }),
    }),
    bindings,
  );
  await worker.fetch(
    new Request("https://gui/runtime/notices", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ noticeKind: "byoa_engine_failed" }),
    }),
    bindings,
  );
  await worker.fetch(
    new Request("https://gui/runtime/triage", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source: "byoa-codex", actionable: true }),
    }),
    bindings,
  );
  const run = await json<{ runId: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/runs", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ trigger: "test" }),
      }),
      bindings,
    ),
  );
  await worker.fetch(
    new Request(`https://gui/runtime/runs/${run.runId}/heartbeat`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ stream: { type: "tool_started", id: "tool-1", name: "shell", input: "pnpm test" } }),
    }),
    bindings,
  );
  await json<{ ok: true }>(
    await worker.fetch(
      new Request(`https://gui/runtime/runs/${run.runId}/attempts`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ attempt: 1, status: "failed_retrying", message: "codex produced no output" }),
      }),
      bindings,
    ),
  );
  await worker.fetch(
    new Request(`https://gui/runtime/runs/${run.runId}/heartbeat`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        stream: { type: "attempt", attempt: 1, status: "failed_retrying", message: "codex produced no output" },
      }),
    }),
    bindings,
  );
  await worker.fetch(
    new Request(`https://gui/runtime/runs/${run.runId}/heartbeat`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ stream: { type: "message_delta", text: "done" } }),
    }),
    bindings,
  );
  await worker.fetch(
    new Request(`https://gui/runtime/runs/${run.runId}/heartbeat`, { method: "POST", headers: auth }),
    bindings,
  );
  await worker.fetch(
    new Request(`https://gui/runtime/runs/${run.runId}/heartbeat`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ agentId: "king-ai-ceo" }),
    }),
    bindings,
  );
  await worker.fetch(
    new Request(`https://gui/runtime/runs/${run.runId}/finish`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ status: "completed" }),
    }),
    bindings,
  );
  await worker.fetch(
    new Request("https://gui/runtime/thinking/unmark", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ conversationIds: ["king-ai-convo"] }),
    }),
    bindings,
  );

  const state = await json<{
    statusLog: { status: string; remediation?: { category: string; summary: string; actions: string[] } | null }[];
    typingLog: { conversationId?: string }[];
    thinkingLog: { action: string }[];
    eventLog: { body: { kind?: string } }[];
    noticeLog: { body: { noticeKind?: string } }[];
    triageLog: { body: { source?: string } }[];
    runLog: { action: string; card?: { summary?: string; sections?: { kind: string; title: string }[] } }[];
    agentBeats?: Record<string, number>;
    runStreams?: Record<string, { message?: string; tools?: { name: string }[]; attempts?: { status: string }[] }>;
    runAttempts?: Record<string, { attempt: number; status: string; agentId: string }[]>;
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.equal(state.statusLog.at(-1)?.status, "thinking");
  assert.equal(state.statusLog.at(-1)?.remediation?.category, "quota");
  assert.match(state.statusLog.at(-1)?.remediation?.summary ?? "", /quota/);
  assert.equal(state.typingLog.at(-1)?.conversationId, "king-ai-convo");
  assert.deepEqual(
    state.thinkingLog.map((row) => row.action),
    ["mark", "unmark"],
  );
  assert.equal(state.eventLog.at(-1)?.body.kind, "gui.event");
  assert.equal(state.noticeLog.at(-1)?.body.noticeKind, "byoa_engine_failed");
  assert.equal(state.triageLog.at(-1)?.body.source, "byoa-codex");
  assert.deepEqual(
    state.runLog.map((row) => row.action),
    ["start", "stream", "heartbeat", "stream", "heartbeat", "stream", "heartbeat", "finish"],
  );
  assert.equal(typeof state.agentBeats?.["king-ai-ceo"], "number");
  assert.equal(state.runStreams?.[run.runId]?.message, "done");
  assert.equal(state.runStreams?.[run.runId]?.tools?.[0]?.name, "shell");
  assert.equal(state.runStreams?.[run.runId]?.attempts?.[0]?.status, "failed_retrying");
  assert.equal(state.runAttempts?.[run.runId]?.[0]?.attempt, 1);
  assert.equal(state.runAttempts?.[run.runId]?.[0]?.agentId, "king-ai-ceo");
  assert.equal(state.runLog.at(-1)?.card?.summary, "Completed");
  assert.equal(
    state.runLog.at(-1)?.card?.sections?.some((section) => section.kind === "tool"),
    true,
  );
  assert.equal(
    state.runLog.at(-1)?.card?.sections?.some((section) => section.title === "Attempts"),
    true,
  );

  const summary = await json<{
    agents: { id: string; remediation?: { category: string; summary: string; actions: string[] } | null }[];
  }>(await worker.fetch(new Request("https://gui/gui/summary"), bindings));
  const agent = summary.agents.find((row) => row.id === "king-ai-ceo");
  assert.equal(agent?.remediation?.category, "quota");
  assert.match(agent?.remediation?.actions[0] ?? "", /Open claude locally/);
});

test("gui runtime bounds persisted run stream state", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const auth = { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" };
  let firstRunId = "";
  let lastRunId = "";
  for (let index = 0; index < 105; index += 1) {
    const run = await json<{ runId: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/runs", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ trigger: { index } }),
        }),
        bindings,
      ),
    );
    await json<{ ok: true }>(
      await worker.fetch(
        new Request(`https://gui/runtime/runs/${run.runId}/attempts`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ attempt: 1, status: "failed_retrying" }),
        }),
        bindings,
      ),
    );
    if (index === 0) firstRunId = run.runId;
    lastRunId = run.runId;
  }

  const state = await json<{ runStreams?: Record<string, unknown>; runAttempts?: Record<string, unknown> }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.equal(Object.keys(state.runStreams ?? {}).length, 100);
  assert.equal(firstRunId in (state.runStreams ?? {}), false);
  assert.equal(lastRunId in (state.runStreams ?? {}), true);
  assert.equal(Object.keys(state.runAttempts ?? {}).length, 100);
  assert.equal(firstRunId in (state.runAttempts ?? {}), false);
  assert.equal(lastRunId in (state.runAttempts ?? {}), true);
});

test("gui runtime run contract rejects replies to the wrong conversation", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/ielts-tutor/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const auth = { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" };
  const first = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "First", workflowId: "ielts-study", teamMode: "single" }),
      }),
      bindings,
    ),
  );
  const second = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "Second", workflowId: "ielts-study", teamMode: "single" }),
      }),
      bindings,
    ),
  );
  const run = await json<{ runId: string; contract?: { conversationId?: string } }>(
    await worker.fetch(
      new Request("https://gui/runtime/runs", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          trigger: { source: "test", engine: "codex" },
          contract: {
            agentId: "ielts-tutor",
            conversationId: first.conversation.id,
            messageId: "msg-1",
            requestId: "msg-1",
          },
        }),
      }),
      bindings,
    ),
  );

  const rejected = await json<{ exitCode: number; text: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/cli", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ runId: run.runId, argv: ["reply", second.conversation.id, "wrong room"] }),
      }),
      bindings,
    ),
  );
  const accepted = await json<{ exitCode: number; text: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/cli", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          runId: run.runId,
          argv: [
            "reply",
            first.conversation.id,
            [
              "right room",
              "",
              structuredWordCards(
                [
                  {
                    text: "right room",
                    clauses: [{ text: "right room", core: "right room", phrases: [] }],
                  },
                ],
                ["right", "room"],
              ),
            ].join("\n"),
          ],
        }),
      }),
      bindings,
    ),
  );

  assert.equal(run.contract?.conversationId, first.conversation.id);
  assert.equal(rejected.exitCode, 64);
  assert.match(rejected.text, /does not match wake conversation/);
  assert.equal(accepted.exitCode, 0);
  assert.equal(accepted.text, "reply posted");
  const actions = await json<{ actions: { kind: string; conversationId?: string; messageId?: string }[] }>(
    await worker.fetch(
      new Request(`https://gui/runtime/runs/${run.runId}/actions`, {
        headers: auth,
      }),
      bindings,
    ),
  );
  assert.deepEqual(
    actions.actions.map((action) => [action.kind, action.conversationId, action.messageId]),
    [["reply", first.conversation.id, "msg-1"]],
  );

  const state = await json<{ messages: { conversation_id: string; body: string }[]; cliLog: { result: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.equal(
    state.messages.some(
      (message) => message.conversation_id === second.conversation.id && message.body === "wrong room",
    ),
    false,
  );
  assert.equal(
    state.messages.some(
      (message) => message.conversation_id === first.conversation.id && message.body.includes("right room"),
    ),
    true,
  );
  assert.equal(
    state.cliLog.some((row) => row.result.includes("run contract mismatch")),
    true,
  );
});

test("gui runtime run contract rejects updates to the wrong task", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/dev/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const auth = { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" };
  const room = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "Tasks", workflowId: "software-dev", teamMode: "team" }),
      }),
      bindings,
    ),
  );
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ conversationId: room.conversation.id, body: "Implement the first thing" }),
    }),
    bindings,
  );
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ conversationId: room.conversation.id, body: "Implement the second thing" }),
    }),
    bindings,
  );
  const before = await json<{ tasks: { id: string; status: string; result?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  const [firstTask, secondTask] = before.tasks;
  const run = await json<{ runId: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/runs", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          trigger: { source: "test", engine: "codex" },
          contract: { agentId: "dev", conversationId: room.conversation.id, taskId: firstTask.id },
        }),
      }),
      bindings,
    ),
  );

  const rejected = await json<{ exitCode: number; text: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/cli", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ runId: run.runId, argv: ["task", "done", secondTask.id, "wrong task"] }),
      }),
      bindings,
    ),
  );

  assert.equal(rejected.exitCode, 64);
  assert.match(rejected.text, /does not match wake task/);
  const after = await json<{ tasks: { id: string; status: string; result?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.equal(after.tasks.find((task) => task.id === secondTask.id)?.status, "assigned");
  assert.equal(after.tasks.find((task) => task.id === secondTask.id)?.result, undefined);
});

test("gui runtime triage ignores ordinary peer room chatter", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const ceoToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const devToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/dev/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );

  await worker.fetch(
    new Request("https://gui/runtime/cli", {
      method: "POST",
      headers: { Authorization: `Bearer ${ceoToken.token}` },
      body: JSON.stringify({ argv: ["reply", "king-ai-convo", "点名任务已完成，后续不用继续报数。"] }),
    }),
    bindings,
  );

  const devTriage = await json<{
    verdict: { actionable: boolean; routeHint?: string; promptNote?: string };
    routeSummary: string;
  }>(
    await worker.fetch(
      new Request("https://gui/runtime/inbox-triage/payload", {
        headers: { Authorization: `Bearer ${devToken.token}` },
      }),
      bindings,
    ),
  );
  assert.equal(devTriage.verdict.actionable, false);
  assert.equal(devTriage.verdict.routeHint, "ignore");
  assert.equal(devTriage.routeSummary, "");
});

test("gui runtime does not wake peers for ordinary agent room chatter", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const ceoToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const devToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/dev/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );

  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "Everyone, reply with 1 if you are here." }),
    }),
    bindings,
  );

  const initialDevTriage = await json<{ verdict: { actionable: boolean; routeHint?: string } }>(
    await worker.fetch(
      new Request("https://gui/runtime/inbox-triage/payload", {
        headers: { Authorization: `Bearer ${devToken.token}` },
      }),
      bindings,
    ),
  );
  assert.equal(initialDevTriage.verdict.actionable, false);

  await json<{ ok: boolean }>(
    await worker.fetch(
      new Request("https://gui/runtime/conversation/mark-read", {
        method: "POST",
        headers: { Authorization: `Bearer ${devToken.token}` },
        body: JSON.stringify({ conversationId: "king-ai-convo" }),
      }),
      bindings,
    ),
  );

  await json<{ text: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/cli", {
        method: "POST",
        headers: { Authorization: `Bearer ${ceoToken.token}` },
        body: JSON.stringify({ argv: ["reply", "king-ai-convo", "1"] }),
      }),
      bindings,
    ),
  );

  const devInbox = await json<{ rows: Array<{ body: string; author_name: string }> }>(
    await worker.fetch(
      new Request("https://gui/runtime/inbox", {
        headers: { Authorization: `Bearer ${devToken.token}` },
      }),
      bindings,
    ),
  );
  assert.equal(
    devInbox.rows.some((row) => row.author_name === "King AI CEO" && row.body === "1"),
    false,
  );
  assert.deepEqual(devInbox.rows, []);

  const devTriage = await json<{ verdict: { actionable: boolean; routeHint?: string } }>(
    await worker.fetch(
      new Request("https://gui/runtime/inbox-triage/payload", {
        headers: { Authorization: `Bearer ${devToken.token}` },
      }),
      bindings,
    ),
  );
  assert.equal(devTriage.verdict.actionable, false);
  assert.equal(devTriage.verdict.routeHint, "ignore");
});

test("gui runtime still wakes peers for mentioned agent room messages", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const ceoToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const devToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/dev/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );

  await json<{ text: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/cli", {
        method: "POST",
        headers: { Authorization: `Bearer ${ceoToken.token}` },
        body: JSON.stringify({ argv: ["reply", "king-ai-convo", "@dev please verify the fix"] }),
      }),
      bindings,
    ),
  );

  const devTriage = await json<{ verdict: { actionable: boolean; routeHint?: string }; routeSummary: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/inbox-triage/payload", {
        headers: { Authorization: `Bearer ${devToken.token}` },
      }),
      bindings,
    ),
  );
  assert.equal(devTriage.verdict.actionable, true);
  assert.equal(devTriage.verdict.routeHint, "steer");
  assert.match(devTriage.routeSummary, /steer\/normal\/msg/);
});

test("gui runtime triage reply hint uses the routed conversation id", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const devToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/dev/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const room = await json<{ conversation: { id: string } }>(
    await worker.fetch(
      new Request("https://gui/gui/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "Project A", workflowId: "software-dev" }),
      }),
      bindings,
    ),
  );

  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ conversationId: room.conversation.id, body: "请修复 Project A 的问题" }),
    }),
    bindings,
  );

  const devTriage = await json<{ verdict: { promptNote?: string } }>(
    await worker.fetch(
      new Request("https://gui/runtime/inbox-triage/payload", {
        headers: { Authorization: `Bearer ${devToken.token}` },
      }),
      bindings,
    ),
  );

  assert.match(devTriage.verdict.promptNote ?? "", new RegExp(`king-ai reply ${room.conversation.id}\\b`));
  assert.doesNotMatch(devTriage.verdict.promptNote ?? "", /king-ai reply king-ai-convo\b/);
});

test("gui runtime bounds append-only signal logs so persisted state cannot grow without limit", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["claude"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const auth = { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" };

  // STATUS_LOG_CAPACITY is 200; push well past it to prove the log is trimmed, not unbounded.
  const cap = 200;
  const pushes = cap + 50;
  for (let i = 0; i < pushes; i++) {
    await worker.fetch(
      new Request("https://gui/runtime/status", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ status: `s-${i}` }),
      }),
      bindings,
    );
  }

  const state = await json<{ statusLog: { status: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.equal(state.statusLog.length, cap, "statusLog must be capped, not grow with request count");
  assert.equal(state.statusLog.at(-1)?.status, `s-${pushes - 1}`, "most recent signal is retained");
  assert.equal(state.statusLog.at(0)?.status, `s-${pushes - cap}`, "oldest entries are dropped FIFO");
});

test("gui runtime rejects unauthenticated state mutations", async () => {
  const bindings = env();
  await pairComputer(bindings, { engines: ["claude"] });

  const statusRes = await worker.fetch(
    new Request("https://gui/runtime/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "spoofed" }),
    }),
    bindings,
  );
  assert.equal(statusRes.status, 401);

  const eventRes = await worker.fetch(
    new Request("https://gui/runtime/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "spoofed.event" }),
    }),
    bindings,
  );
  assert.equal(eventRes.status, 401);

  const runRes = await worker.fetch(
    new Request("https://gui/runtime/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trigger: "spoofed" }),
    }),
    bindings,
  );
  assert.equal(runRes.status, 401);

  const state = await json<{
    statusLog: unknown[];
    eventLog: unknown[];
    runLog: unknown[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.equal(state.statusLog.length, 0);
  assert.equal(state.eventLog.length, 0);
  assert.equal(state.runLog.length, 0);
});

test("gui runtime classifies loop observability snapshots", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const auth = { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" };
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  assert.match((await callCli(["observe"])).text, /classification=idle/);

  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "pending work" }),
    }),
    bindings,
  );
  assert.match((await callCli(["observe"])).text, /classification=backlog_stuck/);
  assert.match(
    (await callCli(["observe", "--classification", "productive"])).text,
    /No observe snapshot matching classification=productive/,
  );
  assert.match((await callCli(["recv"])).text, /pending work/);

  const prerequisite = await callCli(["task", "create", "Prerequisite"]);
  const prerequisiteId = prerequisite.text.match(/Task (task-[^ ]+) created/)?.[1];
  assert.equal(typeof prerequisiteId, "string");
  await callCli(["task", "create", "Blocked followup", "--after", prerequisiteId ?? ""]);
  assert.match((await callCli(["observe"])).text, /classification=blocked/);

  const taskState = await json<{ tasks: { id: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.equal(taskState.tasks.length, 3);
  await callCli(["task", "update", taskState.tasks[1]?.id ?? "", "--status", "review"]);
  const productive = await callCli(["observe", "--json"]);
  assert.match(productive.text, /"classification": "productive"/);
  assert.match(productive.text, /"activeTasks": 3/);

  const run = await json<{ runId: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/runs", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ trigger: "observe-test" }),
      }),
      bindings,
    ),
  );
  await worker.fetch(
    new Request(`https://gui/runtime/runs/${run.runId}/finish`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ status: "failed" }),
    }),
    bindings,
  );
  assert.match((await callCli(["observe"])).text, /classification=error/);
  assert.match((await callCli(["watch", "--json"])).text, /"failedRuns": 1/);
});

test("gui runtime records King AI loop events", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  assert.match((await callCli(["loop", "snapshot"])).text, /classification=idle/);
  assert.match((await callCli(["loop", "tick", "--run", "run-test"])).text, /loop tick 1 run=run-test/);
  assert.match(
    (await callCli(["loop", "emit", "queue.backlog", "--agent", "reviewer", "--pending", "2", '{"source":"manual"}']))
      .text,
    /loop event queue.backlog recorded loop=1/,
  );
  assert.match((await callCli(["loop", "classify"])).text, /loop classified backlog_stuck/);
  assert.match(
    (await callCli(["loop", "recent", "--type", "queue.backlog"])).text,
    /queue\.backlog agent=reviewer pending=2/,
  );

  assert.match(
    (await callCli(["route", "set", "github_issue", "--agent", "reviewer"])).text,
    /route set github_issue -> reviewer/,
  );
  assert.match(
    (await callCli(["route", "emit", "github_issue", "--source", "github", '{"title":"Loop backlog"}'])).text,
    /event routed github_issue -> reviewer/,
  );
  assert.match(
    (await callCli(["loop", "recent", "--agent", "reviewer"])).text,
    /queue\.backlog agent=reviewer pending=1/,
  );

  const task = await callCli(["task", "create", "Loop task", "--assign", "king-ai-ceo"]);
  const taskId = task.text.match(/Task (task-[^ ]+) created/)?.[1];
  assert.equal(typeof taskId, "string");
  assert.match((await callCli(["task", "update", taskId ?? "", "--status", "review"])).text, /updated \[review\]/);
  assert.match(
    (
      await callCli([
        "artifact",
        "put",
        "--kind",
        "tech_spec",
        "--path",
        "gui/loop/spec",
        "--source",
        "repo:gui",
        "--confidence",
        "0.9",
        "--task",
        taskId ?? "",
        '{"date":"2026-06-03"}',
      ])
    ).text,
    /artifact stored/,
  );
  assert.match((await callCli(["loop", "classify"])).text, /loop classified productive/);

  const recent = await callCli(["loop", "recent", "--json"]);
  assert.match(recent.text, /"type": "task.transition"/);
  assert.match(recent.text, /"type": "artifact.created"/);
  assert.match(recent.text, /"type": "loop.classified"/);

  const state = await json<{ loopRunId: string; currentLoop: number; loopEvents: { type: string; loop: number }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.equal(state.loopRunId, "run-test");
  assert.equal(state.currentLoop, 1);
  assert.equal(
    state.loopEvents.some((event) => event.type === "artifact.created" && event.loop === 1),
    true,
  );
});

test("gui runtime exposes King AI runtime preambles", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  assert.match((await callCli(["loop", "tick", "--run", "run-preamble"])).text, /loop tick 1/);
  assert.match((await callCli(["task", "create", "Summarize runtime", "--assign", "king-ai-ceo"])).text, /Task task-/);
  assert.match(
    (await callCli(["context", "set", "decision", "prefer", "runtime", "preamble"])).text,
    /prefer runtime preamble/,
  );
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "please summarize current state" }),
    }),
    bindings,
  );

  const preamble = await json<{ text: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/preamble?agent=king-ai-ceo&reason=wake&runId=run-preamble", {
        headers: { Authorization: `Bearer ${tokenRes.token}` },
      }),
      bindings,
    ),
  );
  assert.match(preamble.text, /Runtime Context \(Loop #1\)/);
  assert.match(preamble.text, /Role: Coordinate the conversation: clarify ambiguous human requests/);
  assert.match(preamble.text, /Run ID: run-preamble/);
  assert.match(preamble.text, /Current Tasks/);
  assert.match(preamble.text, /Summarize runtime/);
  assert.match(preamble.text, /Recent Unread Messages/);
  assert.match(preamble.text, /please summarize current state/);
  assert.match(preamble.text, /Shared Context/);
  assert.match(preamble.text, /decision: prefer runtime preamble/);

  const cliPreamble = await callCli([
    "preamble",
    "--agent",
    "king-ai-ceo",
    "--reason",
    "agenda",
    "--run",
    "run-preamble",
  ]);
  assert.match(cliPreamble.text, /Reason: agenda/);
  assert.match(cliPreamble.text, /Run ID: run-preamble/);
  assert.match((await callCli(["preamble", "--agent", "dev"])).text, /Role: Implement only assigned tasks/);
});

test("gui runtime preamble exposes full wake task ids", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const devToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/dev/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "@dev reply to the roll call" }),
    }),
    bindings,
  );
  const state = await json<{
    tasks: { id: string; title: string; status: string; assignee?: string; conversationId?: string }[];
    messages: { id: string; conversation_id: string; author_kind: string; body: string }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const task = state.tasks.find((row) => row.assignee === "dev");
  const message = state.messages.find(
    (row) => row.author_kind === "human" && row.body === "@dev reply to the roll call",
  );
  assert.ok(task);
  assert.ok(message);
  const run = await json<{ runId: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/runs", {
        method: "POST",
        headers: { Authorization: `Bearer ${devToken.token}` },
        body: JSON.stringify({
          trigger: { source: "sse-wake", engine: "codex" },
          contract: { conversationId: message.conversation_id, messageId: message.id, taskId: task.id },
        }),
      }),
      bindings,
    ),
  );

  const preamble = await json<{ text: string }>(
    await worker.fetch(
      new Request(`https://gui/runtime/preamble?agent=dev&reason=wake&runId=${run.runId}`, {
        headers: { Authorization: `Bearer ${devToken.token}` },
      }),
      bindings,
    ),
  );

  assert.match(preamble.text, /Wake Contract/);
  assert.match(preamble.text, new RegExp(`task: ${task.id}`));
  assert.match(preamble.text, new RegExp(`close with: king-ai task done ${task.id}`));
  assert.match(preamble.text, new RegExp(`\\[assigned\\] ${task.id} ${task.title}`));
});

test("gui runtime supports board, calendar, claims, roster, and agenda", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["claude", "codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  assert.match((await callCli(["card", "create", "Ship gui board"])).text, /card created/);
  const stateWithCard = await json<{ cards: { id: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  const cardId = stateWithCard.cards[0]?.id;
  assert.equal(typeof cardId, "string");
  assert.match((await callCli(["card", "claim", cardId])).text, /card claimed/);
  assert.match((await callCli(["card", "release", cardId])).text, /card released/);
  assert.match((await callCli(["card", "claim", cardId])).text, /card claimed/);
  assert.match((await callCli(["card", "done", cardId])).text, /card moved/);
  assert.match(
    (
      await callCli([
        "calendar",
        "create",
        "Followup",
        "--at",
        "2000-01-01T00:00:00.000Z",
        "--assignee",
        "king-ai-ceo",
        "--prompt",
        "check board",
      ])
    ).text,
    /calendar created/,
  );
  assert.match((await callCli(["claim", "gui-work", "--in", "king-ai-convo"])).text, /claim created/);
  assert.match((await callCli(["unclaim", "gui-work"])).text, /claim released/);

  await worker.fetch(
    new Request("https://gui/gui/card", {
      method: "POST",
      body: JSON.stringify({ title: "Agenda card", assignee: "king-ai-ceo" }),
    }),
    bindings,
  );
  const agenda = await json<{ actionable: boolean; brief: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/agenda", {
        headers: { Authorization: `Bearer ${tokenRes.token}` },
      }),
      bindings,
    ),
  );
  assert.equal(agenda.actionable, true);
  assert.match(agenda.brief, /Agenda card|Calendar due/);

  await worker.fetch(
    new Request("https://gui/runtime/status", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenRes.token}` },
      body: JSON.stringify({ status: "thinking" }),
    }),
    bindings,
  );

  const roster = await json<{
    roster: string;
    agentStates: { id: string; status: string; lifecycle: string; engine: string }[];
  }>(
    await worker.fetch(
      new Request("https://gui/runtime/roster", {
        headers: { Authorization: `Bearer ${tokenRes.token}` },
      }),
      bindings,
    ),
  );
  assert.match(roster.roster, /king-ai-ceo/);
  assert.match(roster.roster, /status=thinking/);
  assert.equal(roster.agentStates[0]?.id, "king-ai-ceo");
  assert.equal(roster.agentStates[0]?.status, "thinking");
  assert.equal(roster.agentStates[0]?.lifecycle, "on-demand");
  assert.equal(roster.agentStates[0]?.engine, "grok");
});

test("gui agent status expires a stale thinking heartbeat back to idle", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const ceoStatus = async () => {
    const summary = await json<{ agents: { id: string; status: string }[] }>(
      await worker.fetch(new Request("https://gui/gui/summary"), bindings),
    );
    return summary.agents.find((agent) => agent.id === "king-ai-ceo")?.status;
  };

  // A freshly posted "thinking" status is reported as-is.
  await worker.fetch(
    new Request("https://gui/runtime/status", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenRes.token}` },
      body: JSON.stringify({ status: "thinking" }),
    }),
    bindings,
  );
  assert.equal(await ceoStatus(), "thinking");

  // A fresh run heartbeat keeps an old status alive, covering agenda/background turns that do not
  // refresh composing claims.
  const run = await json<{ runId: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/runs", {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenRes.token}` },
        body: JSON.stringify({ trigger: "test" }),
      }),
      bindings,
    ),
  );
  await worker.fetch(
    new Request(`https://gui/runtime/runs/${run.runId}/heartbeat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenRes.token}` },
      body: JSON.stringify({ agentId: "king-ai-ceo" }),
    }),
    bindings,
  );
  const active = await json<{
    schema: string;
    state: { statusLog: { at: number }[]; composing: unknown[]; agentBeats?: Record<string, number> };
  }>(await worker.fetch(new Request("https://gui/gui/export-state"), bindings));
  for (const row of active.state.statusLog) row.at = Date.now() - 120_000;
  active.state.composing = [];
  await json<{ ok: true }>(
    await worker.fetch(
      new Request("https://gui/gui/import-state", {
        method: "POST",
        body: JSON.stringify(active),
      }),
      bindings,
    ),
  );
  assert.equal(await ceoStatus(), "thinking");

  // Once both composing and run heartbeats go stale, it must self-clear instead of pinning the run
  // indicator on forever.
  const exported = await json<{
    schema: string;
    state: { statusLog: { at: number }[]; composing: unknown[]; agentBeats?: Record<string, number> };
  }>(await worker.fetch(new Request("https://gui/gui/export-state"), bindings));
  for (const row of exported.state.statusLog) row.at = Date.now() - 120_000;
  exported.state.composing = [];
  exported.state.agentBeats = { "king-ai-ceo": Date.now() - 120_000 };
  await json<{ ok: true }>(
    await worker.fetch(
      new Request("https://gui/gui/import-state", {
        method: "POST",
        body: JSON.stringify(exported),
      }),
      bindings,
    ),
  );
  assert.equal(await ceoStatus(), "idle");
});

test("gui runtime supports cron-backed calendar agenda items", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  const now = new Date();
  const expression = `${now.getMinutes()} ${now.getHours()} * * *`;
  assert.match(
    (
      await callCli([
        "calendar",
        "create",
        "CronCheck",
        "--at",
        "2999-01-01T00:00:00.000Z",
        "--cron",
        expression,
        "--prompt",
        "cron wake",
      ])
    ).text,
    /cron=/,
  );
  assert.match((await callCli(["calendar", "create", "BadCron", "--cron", "*/0 * * * *"])).text, /Invalid step/);

  const agenda = await json<{ actionable: boolean; brief: string }>(
    await worker.fetch(
      new Request("https://gui/runtime/agenda", {
        headers: { Authorization: `Bearer ${tokenRes.token}` },
      }),
      bindings,
    ),
  );
  assert.equal(agenda.actionable, true);
  assert.match(agenda.brief, /CronCheck \[cron/);
  assert.match(agenda.brief, /cron wake/);
});

test("gui runtime supports task pool commands with dependencies", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  const first = await callCli([
    "task",
    "create",
    "Build foundation",
    "--assign",
    "king-ai-ceo",
    "--priority",
    "2",
    "--path",
    "src/runtime",
  ]);
  assert.match(first.text, /Task task-/);
  const firstId = first.text.match(/Task (task-[^ ]+) created/)?.[1];
  assert.equal(typeof firstId, "string");

  const second = await callCli(["task", "create", "Ship feature", "--after", firstId ?? "", "--priority", "7"]);
  const secondId = second.text.match(/Task (task-[^ ]+) created/)?.[1];
  assert.equal(typeof secondId, "string");

  const blockedList = await callCli(["task", "list"]);
  assert.match(blockedList.text, /\[assigned\].*Build foundation/);
  assert.match(blockedList.text, /\[blocked\].*Ship feature.*after:/);
  assert.match(blockedList.text, /paths=src\/runtime/);

  assert.match((await callCli(["task", "get", firstId ?? ""])).text, /"title": "Build foundation"/);
  assert.match(
    (
      await callCli([
        "task",
        "update",
        secondId ?? "",
        "--assign",
        "king-ai-ceo",
        "--status",
        "review",
        "--result",
        "ready",
      ])
    ).text,
    /\[review\]/,
  );
  assert.match((await callCli(["task", "done", firstId ?? "", "foundation", "ready"])).text, /marked done/);
  assert.match((await callCli(["task", "list"])).text, /\[review\].*Ship feature/);

  const roster = await callCli(["roster"]);
  assert.match(roster.text, /tasks=1/);
});

test("gui runtime rejects ambiguous short task id prefixes", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  const first = await callCli(["task", "create", "First ambiguous task"]);
  const second = await callCli(["task", "create", "Second ambiguous task"]);
  const firstId = first.text.match(/Task (task-[^ ]+) created/)?.[1] ?? "";
  const secondId = second.text.match(/Task (task-[^ ]+) created/)?.[1] ?? "";
  assert.notEqual(firstId, "");
  assert.notEqual(secondId, "");

  assert.match((await callCli(["task", "get", "task-"])).text, /ambiguous task id: task-/);
  assert.match((await callCli(["task", "update", "task-", "--status", "done"])).text, /ambiguous task id: task-/);
  assert.match((await callCli(["task", "done", "task-", "wrong task"])).text, /ambiguous task id: task-/);

  const state = await json<{ tasks: { id: string; status: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.equal(state.tasks.find((task) => task.id === firstId)?.status, "pending");
  assert.equal(state.tasks.find((task) => task.id === secondId)?.status, "pending");

  const guiUpdate = await worker.fetch(
    new Request("https://gui/gui/task/task-/update", {
      method: "POST",
      body: JSON.stringify({ status: "done" }),
    }),
    bindings,
  );
  assert.equal(guiUpdate.status, 409);
  assert.match(await guiUpdate.text(), /ambiguous task id: task-/);
});

test("gui runtime supports initiative board links across tasks and capsules", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  const created = await callCli([
    "initiative",
    "create",
    "Advance roadmap",
    "--goal",
    "Ship the next roadmap milestone",
    "--summary",
    "Prioritize external value",
    "--priority",
    "9",
    "--source",
    "README.md,docs/ROADMAP.md",
  ]);
  assert.match(created.text, /Initiative initiative-.*created: "Advance roadmap" \[active\]/);
  const initiativeId = created.text.match(/Initiative (initiative-[^ ]+) created/)?.[1];
  assert.equal(typeof initiativeId, "string");

  const task = await callCli([
    "task",
    "create",
    "Build roadmap endpoint",
    "--assign",
    "dev",
    "--initiative",
    initiativeId ?? "",
    "--subsystem",
    "roadmap-api",
  ]);
  assert.match(task.text, /Task task-/);
  const taskId = task.text.match(/Task (task-[^ ]+) created/)?.[1];
  assert.equal(typeof taskId, "string");
  assert.match(
    (await callCli(["task", "list", "--initiative", initiativeId ?? ""])).text,
    /I:initiati.*subsystem=roadmap-api/,
  );

  const capsule = await callCli([
    "capsule",
    "create",
    "--goal",
    "Implement roadmap endpoint",
    "--owner",
    "dev",
    "--paths",
    "src/roadmap.ts",
    "--acceptance",
    "endpoint tested",
    "--initiative",
    initiativeId ?? "",
    "--task",
    taskId ?? "",
  ]);
  const capsuleId = capsule.text.match(/Capsule (capsule-[^ ]+) created/)?.[1];
  assert.equal(typeof capsuleId, "string");

  assert.match(
    (await callCli(["initiative", "list", "--status", "active"])).text,
    /P9 "Advance roadmap" - Prioritize external value tasks=1 capsules=1/,
  );
  const detail = await callCli(["initiative", "get", initiativeId ?? ""]);
  assert.match(detail.text, /"taskCount": 1/);
  assert.match(detail.text, /"capsuleCount": 1/);
  assert.match(detail.text, /"sources": \[/);

  assert.match(
    (
      await callCli([
        "initiative",
        "update",
        initiativeId ?? "",
        "--status",
        "paused",
        "--summary",
        "Scope adjusted",
        "--priority",
        "4",
      ])
    ).text,
    /\[paused\]/,
  );
  const state = await json<{
    initiatives: { id: string; status: string; priority: number; summary?: string }[];
    tasks: { initiativeId?: string }[];
    capsules: { initiativeId?: string }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const initiative = state.initiatives.find((row) => row.id === initiativeId);
  assert.equal(initiative?.status, "paused");
  assert.equal(initiative?.priority, 4);
  assert.equal(initiative?.summary, "Scope adjusted");
  assert.equal(state.tasks[0]?.initiativeId, initiativeId);
  assert.equal(state.capsules[0]?.initiativeId, initiativeId);
});

test("gui runtime supports change capsule commands with conflict hints", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  const task = await callCli(["task", "create", "Fix webhook ingestion", "--assign", "dev"]);
  const taskId = task.text.match(/Task (task-[^ ]+) created/)?.[1];
  assert.equal(typeof taskId, "string");

  const created = await callCli([
    "capsule",
    "create",
    "--goal",
    "Fix webhook ingestion",
    "--owner",
    "dev",
    "--branch",
    "king-ai/dev/webhook",
    "--base",
    "abc123",
    "--paths",
    "apps/api/src/routes/webhooks.ts,apps/api/src/routes/webhooks.test.ts",
    "--acceptance",
    "webhook forwards payload and tests pass",
    "--task",
    taskId ?? "",
    "--reviewer",
    "cto",
    "--subsystem",
    "api-webhooks",
    "--scope-type",
    "code",
  ]);
  assert.match(created.text, /Capsule capsule-.*created on king-ai\/dev\/webhook \[open\]/);
  const capsuleId = created.text.match(/Capsule (capsule-[^ ]+) created/)?.[1];
  assert.equal(typeof capsuleId, "string");

  assert.match(
    (await callCli(["capsule", "list", "--status", "open", "--owner", "dev", "--reviewer", "cto"])).text,
    /\[open\].*dev king-ai\/dev\/webhook "Fix webhook ingestion".*reviewer=cto.*subsystem=api-webhooks/,
  );
  assert.match(
    (await callCli(["capsule", "mine", "--agent", "dev"])).text,
    /acceptance: webhook forwards payload and tests pass/,
  );
  assert.match((await callCli(["capsule", "get", capsuleId ?? ""])).text, /"scopeType": "code"/);

  const weakConflict = await callCli([
    "capsule",
    "create",
    "--goal",
    "Document webhook behavior",
    "--owner",
    "docs",
    "--paths",
    "apps/api/src/routes/README.md",
    "--subsystem",
    "api-webhooks",
    "--acceptance",
    "docs updated",
  ]);
  assert.match(weakConflict.text, /Conflicts: capsule-.*\(weak_conflict\)/);

  const highConflict = await callCli([
    "capsule",
    "create",
    "--goal",
    "Patch webhook handler",
    "--owner",
    "qa",
    "--paths",
    "apps/api/src/routes/webhooks.ts",
    "--acceptance",
    "handler patch reviewed",
  ]);
  assert.match(highConflict.text, /Conflicts: capsule-.*\(high_conflict\)/);

  assert.match(
    (await callCli(["capsule", "update", capsuleId ?? "", "--status", "in_review", "--reviewer", "lead"])).text,
    /\[in_review\]/,
  );
  const state = await json<{ capsules: { id: string; status: string; reviewer?: string; allowedPaths: string[] }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  const capsule = state.capsules.find((row) => row.id === capsuleId);
  assert.equal(capsule?.status, "in_review");
  assert.equal(capsule?.reviewer, "lead");
  assert.deepEqual(capsule?.allowedPaths, ["apps/api/src/routes/webhooks.ts", "apps/api/src/routes/webhooks.test.ts"]);
});

test("gui runtime supports merge queue state tracking without executing git", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  const task = await callCli(["task", "create", "Merge queue task", "--assign", "dev"]);
  const taskId = task.text.match(/Task (task-[^ ]+) created/)?.[1];
  assert.equal(typeof taskId, "string");

  const capsule = await callCli([
    "capsule",
    "create",
    "--goal",
    "Merge queue capsule",
    "--owner",
    "dev",
    "--branch",
    "king-ai/dev/merge-queue",
    "--paths",
    "src/merge.ts",
    "--task",
    taskId ?? "",
  ]);
  const capsuleId = capsule.text.match(/Capsule (capsule-[^ ]+) created/)?.[1];
  assert.equal(typeof capsuleId, "string");

  const queued = await callCli(["merge", "enqueue", "--capsule", capsuleId ?? "", "--target", "main"]);
  assert.match(queued.text, /merge queued merge-/);
  const mergeId = queued.text.match(/merge queued (merge-[^ ]+)/)?.[1];
  assert.equal(typeof mergeId, "string");
  assert.match((await callCli(["merge", "list"])).text, /\[queued\].*king-ai\/dev\/merge-queue -> main by dev/);
  assert.match((await callCli(["merge", "enqueue", "--capsule", capsuleId ?? ""])).text, /already queued/);
  assert.match((await callCli(["merge", "get", mergeId ?? ""])).text, /"capsuleId": "capsule-/);
  assert.match((await callCli(["merge", "mark", mergeId ?? "", "testing"])).text, /marked testing/);
  assert.match((await callCli(["merge", "mark", mergeId ?? "", "merged"])).text, /marked merged/);

  const state = await json<{
    mergeQueue: { id: string; status: string; branch: string }[];
    capsules: { id: string; status: string }[];
    tasks: { id: string; status: string; result?: string }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.deepEqual(
    state.mergeQueue.map((row) => `${row.branch}:${row.status}`),
    ["king-ai/dev/merge-queue:merged"],
  );
  assert.equal(state.capsules.find((row) => row.id === capsuleId)?.status, "merged");
  assert.equal(state.tasks.find((row) => row.id === taskId)?.status, "done");
  assert.match(state.tasks.find((row) => row.id === taskId)?.result ?? "", /merged via merge-/);

  assert.match((await callCli(["merge", "enqueue", "--branch", "bad branch"])).text, /invalid branch name/);
});

test("gui runtime records CTO-style review gates for capsules", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  const task = await callCli(["task", "create", "Review gate task", "--assign", "dev"]);
  const taskId = task.text.match(/Task (task-[^ ]+) created/)?.[1];
  assert.equal(typeof taskId, "string");
  const capsule = await callCli([
    "capsule",
    "create",
    "--goal",
    "Review gate capsule",
    "--owner",
    "dev",
    "--branch",
    "king-ai/dev/review-gate",
    "--paths",
    "src/review.ts",
    "--acceptance",
    "review gate passes",
    "--task",
    taskId ?? "",
    "--reviewer",
    "cto",
  ]);
  const capsuleId = capsule.text.match(/Capsule (capsule-[^ ]+) created/)?.[1];
  assert.equal(typeof capsuleId, "string");
  const queued = await callCli(["merge", "enqueue", "--capsule", capsuleId ?? ""]);
  const mergeId = queued.text.match(/merge queued (merge-[^ ]+)/)?.[1];
  assert.equal(typeof mergeId, "string");

  const rejected = await callCli([
    "review",
    "record",
    "--capsule",
    capsuleId ?? "",
    "--merge",
    mergeId ?? "",
    "--coverage",
    "92",
    "--checks",
    "true",
    "--acceptance",
    "true",
    "--scope",
    "false",
    "--tests",
    "true",
    "--regressions",
    "true",
    "--comment",
    "scope drift",
  ]);
  assert.match(rejected.text, /decision=changes_requested/);
  assert.match(rejected.text, /coverage below 95%; scope mismatch/);
  const rejectedId = rejected.text.match(/review recorded (review-[^ ]+)/)?.[1];
  assert.equal(typeof rejectedId, "string");
  assert.match((await callCli(["review", "get", rejectedId ?? ""])).text, /"comment": "scope drift"/);
  assert.match(
    (await callCli(["review", "list", "--decision", "changes_requested"])).text,
    /\[changes_requested\].*reviewer=cto.*coverage=92%/,
  );

  const approved = await callCli([
    "review",
    "record",
    "--capsule",
    capsuleId ?? "",
    "--merge",
    mergeId ?? "",
    "--coverage",
    "96",
    "--checks",
    "true",
    "--acceptance",
    "true",
    "--scope",
    "true",
    "--tests",
    "true",
    "--regressions",
    "true",
  ]);
  assert.match(approved.text, /decision=approved/);

  const state = await json<{
    mergeQueue: { id: string; status: string }[];
    reviews: { decision: string; capsuleId: string }[];
    capsules: { id: string; status: string }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.equal(state.mergeQueue.find((row) => row.id === mergeId)?.status, "testing");
  assert.equal(state.capsules.find((row) => row.id === capsuleId)?.status, "in_review");
  assert.deepEqual(
    state.reviews.map((row) => row.decision),
    ["changes_requested", "approved"],
  );
  assert.deepEqual(
    state.reviews.map((row) => row.capsuleId),
    [capsuleId, capsuleId],
  );
});

test("gui runtime supports structured artifact commands", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  const task = await callCli(["task", "create", "Collect evidence"]);
  const taskId = task.text.match(/Task (task-[^ ]+) created/)?.[1];
  assert.equal(typeof taskId, "string");

  const put = await callCli([
    "artifact",
    "put",
    "--kind",
    "tech_spec",
    "--path",
    "runtime/protocol/task-pool",
    "--source",
    "king-ai-ceo",
    "--confidence",
    "0.75",
    "--task",
    taskId ?? "",
    "--content",
    "spec content",
    '{"name":"Task protocol"}',
  ]);
  assert.match(put.text, /artifact stored artifact-/);
  const artifactId = put.text.match(/artifact stored (artifact-[^ ]+)/)?.[1];
  assert.equal(typeof artifactId, "string");
  assert.match((await callCli(["artifact", "check", artifactId ?? ""])).text, /artifact quality valid=false/);
  assert.match(
    (await callCli(["artifact", "check", artifactId ?? ""])).text,
    /metadata should include collection date/,
  );

  assert.match(
    (await callCli(["artifact", "list", "--unverified"])).text,
    /\[unverified\].*tech_spec.*runtime\/protocol\/task-pool/,
  );
  const artifact = await callCli(["artifact", "get", artifactId ?? ""]);
  assert.match(artifact.text, /"content": "spec content"/);
  assert.match(artifact.text, /"name": "Task protocol"/);
  assert.match(artifact.text, /"quality_warnings": \[/);
  assert.match(artifact.text, /"quality_score": 0.88/);

  const goodCheck = await callCli([
    "artifact",
    "check",
    "--kind",
    "budget_item",
    "--path",
    "costs/opex/rent",
    "--source",
    "estimate",
    "--confidence",
    "0.4",
    '{"item":"rent","amount":350000,"currency":"JPY","collected_at":"2026-06-02"}',
  ]);
  assert.match(goodCheck.text, /artifact quality valid=true score=1/);

  assert.match(
    (
      await callCli([
        "artifact",
        "put",
        "--kind",
        "custom_kind",
        "--path",
        "custom/path",
        "--source",
        "king-ai-ceo",
        "--confidence",
        "0.9",
        '{"name":"Custom"}',
      ])
    ).text,
    /non-standard artifact kind/,
  );
  assert.match(
    (
      await callCli([
        "artifact",
        "put",
        "--kind",
        "custom_kind",
        "--path",
        "custom/path",
        "--source",
        "king-ai-ceo",
        "--confidence",
        "0.9",
        "--allow-nonstandard",
        '{"name":"Custom"}',
      ])
    ).text,
    /artifact stored .*warnings=/,
  );
  assert.match(
    (
      await callCli([
        "artifact",
        "check",
        "--kind",
        "budget_item",
        "--path",
        "costs",
        "--source",
        "training_data",
        "--confidence",
        "0.9",
        '{"amount":1}',
      ])
    ).text,
    /path should use domain\/category\/item/,
  );
  assert.match(
    (
      await callCli([
        "artifact",
        "check",
        "--kind",
        "budget_item",
        "--path",
        "costs",
        "--source",
        "training_data",
        "--confidence",
        "0.9",
        '{"amount":1}',
      ])
    ).text,
    /training_data confidence should be <= 0.3/,
  );
});

test("gui runtime supports shared context commands", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  assert.match((await callCli(["context", "get", "decision"])).text, /not found/);
  assert.match(
    (await callCli(["context", "set", "decision", "ship", "task", "pool", "--agent", "planner"])).text,
    /ship task pool/,
  );
  assert.equal((await callCli(["context", "get", "decision"])).text, "ship task pool");
  assert.match((await callCli(["context", "list"])).text, /decision\tship task pool\tupdatedBy=planner/);
  assert.match(
    (await callCli(["context", "set", "decision", "ship", "artifact", "store"])).text,
    /ship artifact store/,
  );

  const state = await json<{ context: { key: string; value: string; updatedBy: string; updatedAt: number }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.equal(state.context[0]?.key, "decision");
  assert.equal(state.context[0]?.value, "ship artifact store");
  assert.equal(state.context[0]?.updatedBy, "king-ai-ceo");
  assert.equal(typeof state.context[0]?.updatedAt, "number");
  assert.match((await callCli(["context", "delete", "decision"])).text, /Deleted/);
  assert.match((await callCli(["context", "list"])).text, /No context entries/);
});

test("gui runtime supports hypothesis tracking with artifact evidence", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  const artifact = await callCli([
    "artifact",
    "put",
    "--kind",
    "market_data",
    "--path",
    "market/evidence/gui",
    "--source",
    "king-ai-ceo",
    "--confidence",
    "0.9",
    '{"name":"Evidence"}',
  ]);
  const artifactId = artifact.text.match(/artifact stored (artifact-[^ ]+)/)?.[1];
  assert.equal(typeof artifactId, "string");

  const created = await callCli([
    "hypothesis",
    "create",
    "Gui runtime needs hypothesis tracking",
    "--rationale",
    "Artifact evidence should support decisions",
    "--expected-value",
    "Better agent research loops",
    "--estimated-cost",
    "1 task",
  ]);
  assert.match(created.text, /Hypothesis hyp-/);
  const hypothesisId = created.text.match(/Hypothesis (hyp-[^ ]+) created/)?.[1];
  assert.equal(typeof hypothesisId, "string");

  assert.match(
    (await callCli(["hypothesis", "list", "--status", "proposed"])).text,
    /\[proposed\].*Gui runtime needs hypothesis tracking/,
  );
  assert.match(
    (
      await callCli([
        "hypothesis",
        "update",
        hypothesisId ?? "",
        "--status",
        "validated",
        "--outcome",
        "Evidence linked",
        "--evidence",
        artifactId ?? "",
      ])
    ).text,
    /status=validated/,
  );
  assert.match(
    (await callCli(["hypothesis", "list", "--status", "validated"])).text,
    new RegExp(`evidence=${artifactId}`),
  );

  const child = await callCli(["hypothesis", "create", "Child branch", "--parent", hypothesisId ?? ""]);
  const childId = child.text.match(/Hypothesis (hyp-[^ ]+) created/)?.[1];
  assert.equal(typeof childId, "string");
  assert.match((await callCli(["hypothesis", "list", "--tree", hypothesisId ?? ""])).text, /Child branch/);

  const state = await json<{ hypotheses: { id: string; status: string; evidenceArtifactIds?: string[] }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.equal(state.hypotheses.find((row) => row.id === hypothesisId)?.status, "validated");
  assert.deepEqual(state.hypotheses.find((row) => row.id === hypothesisId)?.evidenceArtifactIds, [artifactId]);
});

test("gui runtime applies execution plans into scoped tasks", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  const plan = JSON.stringify({
    optionId: "option-1",
    tasks: [
      {
        title: "Design task model",
        description: "Define scoped task fields",
        scope: { paths: ["src/tasks.ts"] },
        dependencies: [],
        estimatedTokens: 1200,
        priority: 12,
      },
      {
        title: "Implement task model",
        description: "Wire task fields into runtime",
        scope: { paths: ["src/tasks.ts"], patterns: ["test/*.test.ts"] },
        dependencies: ["Design task model"],
        estimatedTokens: 2400,
        priority: 8,
      },
    ],
  });

  assert.match(
    (await callCli(["plan", "parse", `\`\`\`json\n${plan}\n\`\`\``])).text,
    /plan option-1: 2 task\(s\), estimatedTokens=3600/,
  );
  const applied = await callCli(["plan", "apply", plan, "--assign", "planner", "--initiative", "initiative-1"]);
  assert.match(applied.text, /plan applied option-1: 2 task\(s\) created/);
  const createdIds = [...applied.text.matchAll(/- (task-[^ ]+) "/g)].map((match) => match[1]);
  assert.equal(createdIds.length, 2);
  assert.match(applied.text, new RegExp(`after=${createdIds[0]?.slice(0, 10)}`));

  const state = await json<{
    tasks: {
      title: string;
      priority: number;
      assignee?: string;
      initiativeId?: string;
      dependsOn?: string[];
      scope?: { paths?: string[]; patterns?: string[] };
      executionProfile?: string;
    }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.deepEqual(
    state.tasks.map((task) => task.title),
    ["Design task model", "Implement task model"],
  );
  assert.equal(state.tasks[0]?.priority, 10);
  assert.equal(state.tasks[1]?.assignee, "planner");
  assert.equal(state.tasks[1]?.initiativeId, "initiative-1");
  assert.deepEqual(state.tasks[1]?.dependsOn, [createdIds[0]]);
  assert.deepEqual(state.tasks[1]?.scope?.patterns, ["test/*.test.ts"]);
  assert.equal(state.tasks[1]?.executionProfile, "plan:option-1");
  assert.match((await callCli(["plan", "parse", '{"tasks":[]}'])).text, /tasks array is empty/);
});

test("gui runtime records structured option evaluations", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  const evaluation = JSON.stringify({
    scores: [
      {
        optionId: "option-a",
        scores: { feasibility: 8, risk: 7, impact: 9, cost: 6 },
        reasoning: "higher impact",
      },
      {
        optionId: "option-b",
        scores: { feasibility: 9, risk: 9, impact: 5, cost: 8 },
        reasoning: "safer path",
      },
    ],
    confidence: 0.65,
    tokensUsed: 1234,
  });

  const parsed = await callCli(["eval", "parse", `\`\`\`json\n${evaluation}\n\`\`\``]);
  assert.match(parsed.text, /evaluation selected=option-b confidence=0.65 requiresApproval=true tokens=1234/);
  assert.match(parsed.text, /option-a total=7.60/);
  assert.match(parsed.text, /option-b total=7.80/);

  const recorded = await callCli([
    "eval",
    "record",
    evaluation,
    "--artifact",
    "artifact-1",
    "--initiative",
    "initiative-1",
  ]);
  assert.match(recorded.text, /evaluation recorded eval-.*selected=option-b requiresApproval=true/);
  const evaluationId = recorded.text.match(/evaluation recorded (eval-[^ ]+)/)?.[1];
  assert.equal(typeof evaluationId, "string");
  assert.match(
    (await callCli(["eval", "list", "--approval-required"])).text,
    /\[approval_required\].*selected=option-b.*artifact=artifact-1/,
  );

  const detail = await callCli(["evaluate", "get", evaluationId ?? ""]);
  assert.match(detail.text, /"selectedOptionId": "option-b"/);
  assert.match(detail.text, /"requiresHumanApproval": true/);
  assert.match(detail.text, /"totalScore": 7.8/);
  assert.match((await callCli(["eval", "parse", '{"scores":[]}'])).text, /scores array is empty/);
});

test("gui runtime tracks run feedback metrics by agent", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  const first = await callCli([
    "feedback",
    "record",
    "--run",
    "run-1",
    "--agent",
    "dev",
    "--task",
    "task-1",
    "--profile",
    "plan:option-a",
    "--completed",
    "true",
    "--tokens",
    "1000",
    "--duration-ms",
    "2000",
    "--steer-count",
    "1",
    "--quality",
    "0.9",
    "--accepted-by-user",
    "true",
    "--artifact-reused",
    "true",
  ]);
  assert.match(first.text, /feedback recorded feedback-.*agent=dev completed=true errored=false/);
  const firstId = first.text.match(/feedback recorded (feedback-[^ ]+)/)?.[1];
  assert.equal(typeof firstId, "string");

  assert.match(
    (
      await callCli([
        "feedback",
        "record",
        "--run",
        "run-2",
        "--agent",
        "dev",
        "--completed",
        "false",
        "--errored",
        "true",
        "--human-intervention",
        "true",
        "--tokens",
        "500",
        "--duration-ms",
        "3000",
        "--revision-count",
        "2",
      ])
    ).text,
    /completed=false errored=true/,
  );
  assert.match(
    (
      await callCli([
        "feedback",
        "record",
        "--run",
        "run-3",
        "--agent",
        "feedback",
        "--completed",
        "true",
        "--tokens",
        "700",
        "--duration-ms",
        "1000",
      ])
    ).text,
    /agent=feedback completed=true/,
  );

  assert.match(
    (await callCli(["feedback", "list", "--agent", "dev", "--errored", "true"])).text,
    /\[error\].*agent=dev.*revisions=2/,
  );
  assert.match((await callCli(["feedback", "list", "--completed", "true"])).text, /2 feedback record\(s\)/);

  const summary = await callCli(["feedback", "summary"]);
  assert.match(summary.text, /dev\truns=2\tsuccessRate=50%/);
  assert.match(summary.text, /feedback\truns=1\tsuccessRate=100%/);
  assert.match(summary.text, /interventionRate=50%/);
  assert.match(summary.text, /avgQuality=0.9/);

  const detail = await callCli(["feedback", "get", firstId ?? ""]);
  assert.match(detail.text, /"executionProfile": "plan:option-a"/);
  assert.match(detail.text, /"acceptedByUser": true/);
  assert.match(detail.text, /"artifactReused": true/);
});

test("gui runtime supports safety approval gate commands", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  assert.match((await callCli(["safety", "check", "git_commit"])).text, /allowed: git_commit/);
  assert.match((await callCli(["safety", "check", "deploy_production"])).text, /approval required: deploy_production/);

  const requested = await callCli([
    "safety",
    "request",
    "deploy_production",
    "--reason",
    "ship release",
    "--context",
    '{"ticket":"REL-1","conversationId":"room-1","taskId":"task-1"}',
  ]);
  assert.match(requested.text, /approval requested approval-/);
  const approvalId = requested.text.match(/approval requested (approval-[^ ]+)/)?.[1];
  assert.equal(typeof approvalId, "string");

  assert.match((await callCli(["safety", "list"])).text, /\[pending\].*deploy_production.*ship release/);
  assert.match((await callCli(["safety", "get", approvalId ?? ""])).text, /"ticket": "REL-1"/);
  assert.match((await callCli(["safety", "approve", approvalId ?? ""])).text, /approval approved/);
  assert.match((await callCli(["safety", "approve", approvalId ?? ""])).text, /status=approved/);

  const denied = await callCli(["approval", "request", "delete_data", "--reason", "cleanup old records"]);
  const deniedId = denied.text.match(/approval requested (approval-[^ ]+)/)?.[1];
  assert.equal(typeof deniedId, "string");
  assert.match((await callCli(["safety", "deny", deniedId ?? "", "--reason", "too broad"])).text, /approval denied/);
  assert.match((await callCli(["safety", "list", "--status", "denied"])).text, /too broad/);

  const state = await json<{
    approvals: { action: string; status: string; conversationId?: string; taskId?: string }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.deepEqual(
    state.approvals.map((approval) => `${approval.action}:${approval.status}`),
    ["deploy_production:approved", "delete_data:denied"],
  );
  assert.equal(state.approvals[0]?.conversationId, "room-1");
  assert.equal(state.approvals[0]?.taskId, "task-1");
});

test("gui runtime detects path conflicts for cards and claims", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}` },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  assert.match(
    (await callCli(["claim", "backend-work", "--paths", "src/api,src/service", "--owner", "agent-a"])).text,
    /claim created/,
  );
  assert.match(
    (await callCli(["claim", "api-work", "--paths", "src/api/routes"])).text,
    /path conflict: claim .* already covers src\/api/,
  );
  assert.match((await callCli(["claim", "docs-work", "--paths", "README.md"])).text, /claim created/);
  assert.match(
    (await callCli(["task", "create", "Own billing", "--assign", "agent-c", "--path", "src/billing"])).text,
    /Task task-/,
  );
  assert.match(
    (await callCli(["claim", "billing-work", "--paths", "src/billing/invoices", "--owner", "agent-d"])).text,
    /path conflict: task .* already covers src\/billing/,
  );

  assert.match((await callCli(["card", "create", "Touch API", "--paths", "src/api"])).text, /card created/);
  const state = await json<{ cards: { id: string; allowedPaths?: string[] }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  const cardId = state.cards.at(-1)?.id;
  if (!cardId) assert.fail("expected created card id");
  assert.deepEqual(state.cards.at(-1)?.allowedPaths, ["src/api"]);
  assert.match(
    (await callCli(["card", "claim", cardId, "--owner", "agent-b"])).text,
    /path conflict: claim .* already covers src\/api/,
  );
  assert.match(
    (await callCli(["capsule", "create", "--goal", "Own docs", "--paths", "docs/runtime", "--owner", "agent-a"])).text,
    /Capsule capsule-/,
  );
  assert.match(
    (await callCli(["task", "create", "Touch docs runtime", "--assign", "agent-b", "--path", "docs/runtime/api"])).text,
    /Warnings: capsule .* overlaps docs\/runtime/,
  );
});

test("gui runtime supports quotes, reactions, docs, dms, and composing-aware glance", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["claude", "codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const auth = { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" };
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "quote me" }),
    }),
    bindings,
  );
  const firstState = await json<{ messages: { id: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  const messageId = firstState.messages[0]?.id;
  assert.equal(typeof messageId, "string");

  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  assert.match((await callCli(["reply", "king-ai-convo", "--quote", messageId, "quoted reply"])).text, /reply posted/);
  assert.match((await callCli(["reply", "king-ai-convo", "line 1\nline 2 with `code` and $var"])).text, /reply posted/);
  assert.match((await callCli(["react", messageId, "(ok)"])).text, /reaction posted/);
  assert.match((await callCli(["dm", "king-ai-ceo", "hello teammate"])).text, /dm posted/);
  assert.match((await callCli(["doc", "create", "Plan", "Ship the gui"])).text, /doc created/);
  assert.match((await callCli(["doc", "list"])).text, /Plan/);
  const docState = await json<{ docs: { id: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  const docId = docState.docs[0]?.id;
  assert.equal(typeof docId, "string");
  assert.match((await callCli(["doc", "append", docId, "Next step"])).text, /doc appended/);
  assert.match((await callCli(["doc", "show", docId])).text, /Next step/);
  assert.match((await callCli(["doc", "update", docId, "Final body"])).text, /doc updated/);
  assert.match((await callCli(["doc", "show", docId])).text, /Final body/);
  assert.match((await callCli(["claim", "shared-work", "--in", "king-ai-convo"])).text, /claim created/);
  await worker.fetch(
    new Request("https://gui/runtime/thinking/mark", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ conversationIds: ["king-ai-convo"] }),
    }),
    bindings,
  );
  const glance = await callCli(["glance", "king-ai-convo"]);
  assert.match(glance.text, /Claim: shared-work by king-ai-ceo/);
  assert.match(glance.text, /Composing: King AI CEO/);
  await worker.fetch(
    new Request("https://gui/runtime/thinking/unmark", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ conversationIds: ["king-ai-convo"] }),
    }),
    bindings,
  );
  const quietGlance = await callCli(["glance", "king-ai-convo"]);
  assert.doesNotMatch(quietGlance.text, /Composing: King AI CEO/);

  const finalState = await json<{
    messages: { quoted_message_id?: string; body: string }[];
    reactions: { messageId: string; emoji: string }[];
    docs: { title: string }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.equal(
    finalState.messages.some((msg) => msg.quoted_message_id === messageId),
    true,
  );
  assert.equal(
    finalState.messages.some((msg) => msg.body === "line 1\nline 2 with `code` and $var"),
    true,
  );
  assert.deepEqual(
    finalState.reactions.map((row) => [row.messageId, row.emoji]),
    [[messageId, "(ok)"]],
  );
  assert.deepEqual(
    finalState.docs.map((doc) => doc.title),
    ["Plan"],
  );
});

test("gui resolves pending human decisions through the decisions endpoint", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/king-ai-ceo/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const callCli = async (argv: string[]) =>
    json<{ text: string }>(
      await worker.fetch(
        new Request("https://gui/runtime/cli", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ argv }),
        }),
        bindings,
      ),
    );

  // An agent escalates a guarded action, creating a pending human decision.
  const requested = await callCli(["safety", "request", "deploy_production", "--reason", "ship release"]);
  const approvalId = (requested.text.match(/approval requested (\S+)/) ?? [])[1];
  assert.equal(typeof approvalId, "string");

  const before = await json<{ approvals: { id: string; status: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.equal(before.approvals.find((row) => row.id === approvalId)?.status, "pending");

  // The human approves it from the GUI decisions view.
  const resolved = await json<{ ok: boolean; approval: { status: string; resolvedAt?: number } }>(
    await worker.fetch(
      new Request(`https://gui/gui/approvals/${approvalId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      }),
      bindings,
    ),
  );
  assert.equal(resolved.ok, true);
  assert.equal(resolved.approval.status, "approved");
  assert.equal(typeof resolved.approval.resolvedAt, "number");

  const after = await json<{ approvals: { id: string; status: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  assert.equal(after.approvals.find((row) => row.id === approvalId)?.status, "approved");

  // A resolved decision cannot be resolved again.
  const repeat = await worker.fetch(
    new Request(`https://gui/gui/approvals/${approvalId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "deny" }),
    }),
    bindings,
  );
  assert.equal(repeat.status, 409);

  // An unknown decision id is reported as missing.
  const missing = await worker.fetch(
    new Request("https://gui/gui/approvals/nope/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    }),
    bindings,
  );
  assert.equal(missing.status, 404);
});

test("gui bridges host workflow decisions when a host url is configured", async () => {
  const calls: { command?: string; actorRole?: string; input?: Record<string, unknown> }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/commands/run")) {
      const body =
        init && typeof init.body === "string"
          ? (JSON.parse(init.body) as { command?: string; input?: Record<string, unknown> })
          : {};
      calls.push(body);
      if (body.command === "workflow-list") {
        return new Response(
          JSON.stringify({
            ok: true,
            command: "workflow-list",
            exitCode: 0,
            text: "",
            json: {
              cards: [
                {
                  id: "decision-7",
                  kind: "decision",
                  status: "waiting_human",
                  title: "Approve deploy",
                  ownerRole: "ops",
                  decisionBy: "human",
                  detail: "Need approval before deploy",
                },
              ],
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (body.command === "workflow-update") {
        return new Response(
          JSON.stringify({
            ok: true,
            command: "workflow-update",
            exitCode: 0,
            text: "",
            json: { card: { id: body.input?.id, status: body.input?.status } },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    // Unconfigured: bridge is a graceful no-op.
    const unconfigured = await json<{ configured: boolean; cards: unknown[] }>(
      await worker.fetch(new Request("https://gui/gui/host-decisions"), env()),
    );
    assert.equal(unconfigured.configured, false);
    assert.deepEqual(unconfigured.cards, []);

    const bindings = env(undefined, {
      KING_AI_HOST_URL: "http://127.0.0.1:8799",
      KING_AI_HOST_OUTPUT_DIR: "deliverables",
    });

    // Configured: waiting_human host decision cards are surfaced.
    const listed = await json<{
      configured: boolean;
      cards: { id: string; status: string; decisionBy?: string; detail?: string }[];
      workflowCards: { id: string; decisionBy?: string; detail?: string }[];
    }>(await worker.fetch(new Request("https://gui/gui/host-decisions"), bindings));
    assert.equal(listed.configured, true);
    assert.equal(listed.cards[0]?.id, "decision-7");
    assert.equal(listed.cards[0]?.decisionBy, "human");
    assert.equal(listed.cards[0]?.detail, "Need approval before deploy");
    const workflowDecision = listed.workflowCards.find((card) => card.id === "decision-7");
    assert.equal(workflowDecision?.decisionBy, "human");
    assert.equal(workflowDecision?.detail, "Need approval before deploy");
    const listCall = calls.find((c) => c.command === "workflow-list");
    assert.equal(listCall?.input?.kind, "decision");
    assert.equal(listCall?.input?.status, "waiting_human");
    assert.equal(listCall?.input?.outputDir, "deliverables");
    assert.equal(listCall?.actorRole, "reviewer");

    // Approving from the GUI proxies a host workflow-update to status=done.
    const resolved = await json<{ ok: boolean }>(
      await worker.fetch(
        new Request("https://gui/gui/host-decisions/decision-7/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: "approve" }),
        }),
        bindings,
      ),
    );
    assert.equal(resolved.ok, true);
    const updateCall = calls.find((c) => c.command === "workflow-update");
    assert.equal(updateCall?.input?.id, "decision-7");
    assert.equal(updateCall?.input?.status, "done");
    assert.equal(updateCall?.actorRole, "reviewer");
    assert.equal(updateCall?.input?.humanApproved, true);
    assert.equal(updateCall?.input?.approvedBy, "gui-human");

    // An invalid decision is rejected; resolving without a host url is a 404.
    const bad = await worker.fetch(
      new Request("https://gui/gui/host-decisions/decision-7/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "maybe" }),
      }),
      bindings,
    );
    assert.equal(bad.status, 400);

    const noBridge = await worker.fetch(
      new Request("https://gui/gui/host-decisions/decision-7/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      }),
      env(),
    );
    assert.equal(noBridge.status, 404);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("gui auto uses the local host bridge for localhost development only", async () => {
  const calls: { url: string; command?: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://127.0.0.1:8799/commands/run") {
      const body = init && typeof init.body === "string" ? (JSON.parse(init.body) as { command?: string }) : {};
      calls.push({ url, command: body.command });
      return new Response(
        JSON.stringify({ ok: true, command: body.command, exitCode: 0, text: "", json: { devices: [] } }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const local = await json<{ configured: boolean }>(
      await worker.fetch(new Request("http://localhost:8787/gui/remote-devices"), env()),
    );
    assert.equal(local.configured, true);
    assert.deepEqual(
      calls.map((call) => call.command),
      ["remote-list"],
    );

    const remote = await worker.fetch(new Request("https://gui/gui/remote-devices"), env());
    assert.equal(remote.status, 404);
    const remoteBody = (await remote.json()) as { configured?: boolean; error?: string };
    assert.equal(remoteBody.configured, false);
    assert.equal(remoteBody.error, "host bridge not configured");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("gui dev helper strips package-manager argument separators", () => {
  const result = spawnSync(process.execPath, ["scripts/dev-with-host.mjs", "--", "--port", "8787"], {
    cwd: process.cwd(),
    env: { ...process.env, KING_AI_GUI_DEV_DRY_RUN: "1" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as { hostArgs: string[]; wranglerArgs: string[] };
  assert.deepEqual(payload.hostArgs, ["--filter", "@suwujs/king-ai", "dev", "host", "serve"]);
  assert.deepEqual(payload.wranglerArgs, ["exec", "wrangler", "dev", "--config", "wrangler.toml", "--port", "8787"]);
});

test("root dev helper strips package-manager argument separators", () => {
  const result = spawnSync(process.execPath, ["../../scripts/dev-cli.mjs", "--", "host", "status", "--json"], {
    cwd: process.cwd(),
    env: { ...process.env, KING_AI_CLI_DEV_DRY_RUN: "1" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as { cliArgs: string[] };
  assert.deepEqual(payload.cliArgs, ["--filter", "@suwujs/king-ai", "dev", "host", "status", "--json"]);
});

test("GET /health returns worker version and runtime features without auth", async () => {
  const bindings = env();
  const res = await worker.fetch(new Request("https://gui/health"), bindings);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok?: boolean;
    version?: string;
    service?: string;
    runtimeFeatures?: string[];
    cliPackage?: string;
  };
  assert.equal(body.ok, true);
  assert.equal(body.service, "king-ai-gui-worker");
  assert.match(body.version || "", /^\d+\.\d+\.\d+$/);
  assert.match(body.cliPackage || "", /^@suwujs\/king-ai@/);
  assert.equal(body.runtimeFeatures?.includes("wake-dedup"), true);

  const alias = await worker.fetch(new Request("https://gui/api/version"), bindings);
  assert.equal(alias.status, 200);
  const aliasBody = (await alias.json()) as { version?: string };
  assert.equal(aliasBody.version, body.version);
});

test("shouldSuppressAgentWake skips settled message and task repeats", () => {
  const conversationId = "convo-ielts";
  const humanId = "msg-human-1";
  const replyId = "msg-agent-1";
  const taskId = "task-1";
  const base = {
    conversations: [{ id: conversationId, teamMode: "single" as const, kind: "group" as const }],
    messages: [
      { id: humanId, conversation_id: conversationId, author_kind: "human", created_at: 1, readBy: [] as string[] },
      {
        id: replyId,
        conversation_id: conversationId,
        author_kind: "agent",
        author_agent_id: "ielts-tutor",
        quoted_message_id: humanId,
        status: "done",
        created_at: 2,
        readBy: ["ielts-tutor"],
      },
    ],
    tasks: [
      {
        id: taskId,
        status: "done",
        assignee: "ielts-tutor",
        requestMessageId: humanId,
        conversationId,
      },
    ],
  };

  assert.equal(agentReplyForMessage(base, humanId, "ielts-tutor"), true);
  assert.equal(isMessageInboxSettled(base, humanId, "ielts-tutor"), true);

  const settled = shouldSuppressAgentWake(base, {
    agentId: "ielts-tutor",
    conversationId,
    messageId: humanId,
    taskId,
  });
  assert.equal(settled.suppress, true);
  assert.match(settled.reason || "", /settled|answered/i);

  const openTask = {
    ...base,
    tasks: [{ ...base.tasks[0], status: "assigned" }],
  };
  assert.equal(
    shouldSuppressAgentWake(openTask, {
      agentId: "ielts-tutor",
      conversationId,
      messageId: humanId,
      taskId,
    }).suppress,
    false,
  );

  assert.equal(
    shouldSuppressAgentWake(base, { config: true, agentId: "ielts-tutor", messageId: humanId }).suppress,
    false,
  );

  const readCtx = {
    ...base,
    messages: base.messages.map((row) => ({ ...row, readBy: [...row.readBy] })),
  };
  applyAgentReadUpTo(readCtx, { conversationId, messageId: humanId, agentId: "ielts-tutor" });
  assert.equal(readCtx.messages.find((row) => row.id === humanId)?.readBy.includes("ielts-tutor"), true);
});

test("shouldSuppressAgentWake still wakes coordinator for loop-closing task", () => {
  const conversationId = "convo-ielts";
  const humanId = "msg-human-1";
  const base = {
    conversations: [{ id: conversationId, teamMode: "single" as const, kind: "group" as const }],
    messages: [
      { id: humanId, conversation_id: conversationId, author_kind: "human", created_at: 1, readBy: [] as string[] },
      {
        id: "msg-agent-1",
        conversation_id: conversationId,
        author_kind: "agent",
        author_agent_id: "ielts-tutor",
        quoted_message_id: humanId,
        status: "done",
        created_at: 2,
        readBy: ["ielts-tutor"],
      },
    ],
    tasks: [
      {
        id: "task-1",
        status: "done",
        assignee: "king-ai-ceo",
        requestMessageId: humanId,
        conversationId,
      },
    ],
  };
  assert.equal(
    shouldSuppressAgentWake(base, {
      agentId: "king-ai-ceo",
      conversationId,
      taskId: "task-1",
      agenda: true,
    }).suppress,
    false,
  );
  assert.equal(
    shouldSuppressAgentWake(base, {
      agentId: "ielts-tutor",
      conversationId,
      messageId: humanId,
      taskId: "task-1",
    }).suppress,
    true,
  );
});

test("wakeEventVisibleToAgent only broadcasts undirected wakes for global reset/import", () => {
  assert.equal(wakeEventVisibleToAgent({ data: { agentId: "dev" } }, "dev"), true);
  assert.equal(wakeEventVisibleToAgent({ data: { agentId: "dev" } }, "reviewer"), false);
  assert.equal(wakeEventVisibleToAgent({ data: { agenda: true } }, "dev"), false);
  assert.equal(wakeEventVisibleToAgent({ data: { resetState: true } }, "dev"), true);
  assert.equal(wakeEventVisibleToAgent({ data: { importedState: true } }, "reviewer"), true);
  // Runtime config changes are computer-wide, so every connected runner must see them.
  assert.equal(wakeEventVisibleToAgent({ data: { config: true } }, "dev"), true);
  assert.equal(wakeEventVisibleToAgent({ data: { config: true } }, "reviewer"), true);
});

test("gui events SSE pushes a generic change nudge on any state change", async () => {
  const bindings = env();
  const eventsRes = await worker.fetch(new Request("https://gui/gui/events"), bindings);
  assert.equal(eventsRes.status, 200);
  assert.match(eventsRes.headers.get("Content-Type") || "", /text\/event-stream/);
  const reader = eventsRes.body!.getReader();
  const decoder = new TextDecoder();

  // The stream opens with a comment so the connection is established before any change.
  const opening = await reader.read();
  assert.match(decoder.decode(opening.value), /connected/);

  // Any broadcast (here an agent-config rename) should reach the GUI as a generic "change" event.
  await json(
    await worker.fetch(
      new Request("https://gui/gui/agent-config", {
        method: "POST",
        body: JSON.stringify({ name: "Renamed Operator" }),
      }),
      bindings,
    ),
  );

  let buffer = "";
  const deadline = Date.now() + 2000;
  while (!buffer.includes("event: change") && Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ value: Uint8Array | undefined }>((resolve) => setTimeout(() => resolve({ value: undefined }), 300)),
    ]);
    if (chunk.value) buffer += decoder.decode(chunk.value);
  }
  await reader.cancel();
  assert.match(buffer, /event: change/);
});

test("resolveWakeData fills missing agent targets for agenda and conversation wakes", () => {
  const ctx = wakeResolveContextFromState({
    agents: [{ id: "king-ai-ceo" }, { id: "dev" }],
    conversations: [
      {
        id: "demo",
        coordinatorAgentId: "king-ai-ceo",
        teamMode: "team",
        kind: "group",
      },
    ],
    cards: [{ id: "card-1", title: "t", column: "todo", assignee: "dev" }],
    tasks: [],
    defaultConversationId: "king-ai-convo",
    defaultCoordinatorAgentId: "king-ai-ceo",
  });
  assert.equal(resolveWakeData(ctx, { agenda: true, cardId: "card-1" }).agentId, "dev");
  assert.equal(resolveWakeData(ctx, { conversationId: "demo" }).agentId, "king-ai-ceo");
});

test("triageResponseMode maps team conversations to one-of-us", () => {
  const conversation = {
    id: "demo",
    title: "demo",
    kind: "group" as const,
    teamMode: "team" as const,
    created_at: 0,
    updated_at: 0,
  };
  assert.equal(triageResponseMode(conversation, undefined, "dev"), "one-of-us");
  assert.equal(triageResponseMode({ ...conversation, teamMode: "single" }, undefined, "dev"), "me");
  assert.equal(
    triageResponseMode(
      conversation,
      { row: { to_agent_id: "dev" }, score: 1, priority: "normal", type: "message", route: "steer", reasons: [] },
      "dev",
    ),
    "me",
  );
});

test("shouldAutoDelegateMessage keeps single-mode tracking and gates casual team chatter", () => {
  const single = {
    id: "x",
    title: "x",
    kind: "group" as const,
    teamMode: "single" as const,
    created_at: 0,
    updated_at: 0,
  };
  const team = { ...single, teamMode: "team" as const };
  assert.equal(shouldAutoDelegateMessage(single, "reply with 1"), true);
  assert.equal(shouldAutoDelegateMessage(team, "hello"), false);
  assert.equal(shouldAutoDelegateMessage(team, "大家好"), false);
  assert.equal(shouldAutoDelegateMessage(team, "所有人在回个 1"), false);
  assert.equal(shouldAutoDelegateMessage(team, "everyone roll call reply with 1"), false);
  assert.equal(shouldAutoDelegateMessage(team, "你在？"), false);
  assert.equal(shouldAutoDelegateMessage(team, "轮流报数"), false);
  assert.equal(shouldAutoDelegateMessage(team, "@dev roll call reply"), true);
  assert.equal(shouldAutoDelegateMessage(team, "research competitors and source evidence"), true);
  assert.equal(shouldAutoDelegateMessage(team, "请团队实现多角色协作"), true);
  assert.equal(shouldAutoDelegateMessage(team, "接下来做什么"), false);
  assert.equal(shouldAutoDelegateMessage(team, "还没改完？"), false);
  assert.equal(shouldAutoDelegateMessage(team, "你推荐个方案"), false);
  assert.equal(shouldAutoDelegateMessage(team, "是不是有问题?"), false);
  assert.equal(isPlannerGuidanceMessage(team, "继续下一步"), true);
  assert.equal(isPlannerGuidanceMessage(single, "继续下一步"), false);
});

test("planner guidance in #all does not spawn dev tasks", async () => {
  const bindings = env();
  await pairComputer(bindings, { engines: ["grok"] });
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ conversationId: "king-ai-convo", body: "接下来做什么" }),
    }),
    bindings,
  );

  const state = await json<{
    tasks: { requestMessageId?: string; assignee?: string }[];
    messages: { id: string; body: string; author_kind: string }[];
    wakeLog?: { event: string; data: { agentId?: string; taskId?: string; agenda?: boolean } }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const human = state.messages.find((row) => row.author_kind === "human" && row.body === "接下来做什么");
  assert.equal(
    state.tasks.some((row) => row.requestMessageId === human?.id),
    false,
  );
  assert.equal(
    state.wakeLog?.some(
      (row) =>
        row.event === "wake" &&
        row.data.agentId === "king-ai-ceo" &&
        row.data.taskId === undefined &&
        row.data.agenda !== true,
    ),
    true,
  );
  assert.equal(
    state.wakeLog?.some((row) => row.data.agentId === "dev" && row.data.agenda === true),
    false,
  );
});

test("presence checks in #all do not spawn reviewer tasks", async () => {
  const bindings = env();
  await pairComputer(bindings, { engines: ["grok"] });
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ conversationId: "king-ai-convo", body: "你在？" }),
    }),
    bindings,
  );

  const state = await json<{
    tasks: { requestMessageId?: string; assignee?: string; reviewerAgentId?: string; coordinationOnly?: boolean }[];
    messages: { id: string; body: string; to_agent_id?: string; author_kind: string }[];
    wakeLog?: { event: string; data: { agentId?: string; taskId?: string; agenda?: boolean } }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const human = state.messages.find((row) => row.author_kind === "human" && row.body === "你在？");
  assert.equal(
    state.tasks.some((row) => row.requestMessageId === human?.id),
    false,
  );
  assert.equal(
    state.messages.some((row) => row.to_agent_id === "reviewer" && row.body.includes("Task assigned")),
    false,
  );
  assert.equal(
    state.wakeLog?.some(
      (row) =>
        row.event === "wake" &&
        row.data.agentId === "king-ai-ceo" &&
        row.data.taskId === undefined &&
        row.data.agenda !== true,
    ),
    true,
  );
  assert.equal(
    state.wakeLog?.some((row) => row.data.agentId === "dev" && row.data.agenda === true),
    false,
  );
});

test("isLightweightCoordinationMessage treats direct presence pings as coordination", () => {
  const team = { id: "x", title: "x", kind: "group" as const, teamMode: "team" as const };
  assert.equal(isLightweightCoordinationMessage(team, "你在？"), true);
  assert.equal(isLightweightCoordinationMessage(team, "在吗"), true);
  assert.equal(isLightweightCoordinationMessage(team, "fix the login bug"), false);
});

test("isGroupRollCallMessage only catches broad team attendance pings", () => {
  const team = { id: "x", title: "x", kind: "group" as const, teamMode: "team" as const, created_at: 0, updated_at: 0 };
  const single = { ...team, teamMode: "single" as const };
  assert.equal(isGroupRollCallMessage(team, "所有人在回个 1"), true);
  assert.equal(isGroupRollCallMessage(team, "everyone roll call reply with 1"), true);
  assert.equal(isGroupRollCallMessage(team, "@dev roll call reply"), false);
  assert.equal(isGroupRollCallMessage(team, "hello"), false);
  assert.equal(isGroupRollCallMessage(single, "所有人在回个 1"), false);
});

test("isGroupSequentialCountMessage catches round-robin count games", () => {
  const team = { id: "x", title: "x", kind: "group" as const, teamMode: "team" as const };
  assert.equal(isGroupSequentialCountMessage(team, "轮流报数"), true);
  assert.equal(isGroupSequentialCountMessage(team, "大家按顺序报数"), true);
  assert.equal(isGroupSequentialCountMessage(team, "team count in order reply with number"), true);
  assert.equal(isGroupSequentialCountMessage(team, "@dev fix the login bug"), false);
  assert.equal(isLightweightCoordinationMessage(team, "轮流报数"), true);
});

test("settleTaskInboxForAgents marks conversation steers read for routed agents", () => {
  const messages = [
    { id: "m1", conversation_id: "c1", author_kind: "human", created_at: 1, readBy: [] as string[] },
    { id: "m2", conversation_id: "c1", author_kind: "system", created_at: 2, readBy: [] as string[] },
  ];
  settleTaskInboxForAgents(messages, { conversationId: "c1", agentIds: ["dev", "reviewer"] });
  assert.deepEqual(messages[0].readBy, ["dev", "reviewer"]);
  assert.deepEqual(messages[1].readBy, ["dev", "reviewer"]);
});

test("sequential count games in #all do not spawn reviewer tasks", async () => {
  const bindings = env();
  await pairComputer(bindings, { engines: ["grok"] });
  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ conversationId: "king-ai-convo", body: "轮流报数" }),
    }),
    bindings,
  );

  const state = await json<{
    tasks: { requestMessageId?: string; assignee?: string; reviewerAgentId?: string }[];
    messages: { id: string; body: string; to_agent_id?: string; author_kind: string }[];
    wakeLog?: { event: string; data: { agentId?: string; taskId?: string; agenda?: boolean } }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const human = state.messages.find((row) => row.author_kind === "human" && row.body === "轮流报数");
  assert.equal(
    state.tasks.some((row) => row.requestMessageId === human?.id),
    false,
  );
  assert.equal(
    state.messages.some((row) => row.to_agent_id === "reviewer" && row.body.includes("Task assigned")),
    false,
  );
  assert.equal(
    state.wakeLog?.some(
      (row) =>
        row.event === "wake" &&
        row.data.agentId === "king-ai-ceo" &&
        row.data.taskId === undefined &&
        row.data.agenda !== true,
    ),
    true,
  );
});

test("task done settles steer inbox for assignee reviewer and coordinator", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const devToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/dev/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );
  const reviewerToken = await json<{ token: string }>(
    await worker.fetch(
      new Request("https://gui/api/agents/reviewer/runtime-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.deviceToken}` },
      }),
      bindings,
    ),
  );

  await worker.fetch(
    new Request("https://gui/gui/message", {
      method: "POST",
      body: JSON.stringify({ body: "@dev ship the inbox settle check" }),
    }),
    bindings,
  );

  const assigned = await json<{ tasks: { id: string; assignee?: string; status: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings),
  );
  const task = assigned.tasks.find((row) => row.assignee === "dev" && row.status === "assigned");
  assert.ok(task);

  await worker.fetch(
    new Request("https://gui/runtime/cli", {
      method: "POST",
      headers: { Authorization: `Bearer ${devToken.token}` },
      body: JSON.stringify({ argv: ["task", "done", task.id, "done"] }),
    }),
    bindings,
  );

  await worker.fetch(
    new Request("https://gui/runtime/cli", {
      method: "POST",
      headers: { Authorization: `Bearer ${reviewerToken.token}` },
      body: JSON.stringify({ argv: ["task", "done", task.id, "--review", "approved"] }),
    }),
    bindings,
  );

  const state = await json<{
    messages: { id: string; body: string; readBy: string[]; priority?: string; to_agent_id?: string }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const steers = state.messages.filter(
    (row) => row.priority === "steer" && row.body.includes(task.id) && row.body.startsWith("Task assigned"),
  );
  assert.equal(steers.length >= 2, true);
  for (const steer of steers) {
    assert.equal(steer.readBy.includes("dev"), true, steer.body);
    assert.equal(steer.readBy.includes("reviewer"), true, steer.body);
    assert.equal(steer.readBy.includes("king-ai-ceo"), true, steer.body);
  }
  const completionSteer = state.messages.find(
    (row) => row.priority === "steer" && row.body.includes(task.id) && row.body.startsWith("Task completed"),
  );
  assert.ok(completionSteer);
  assert.equal(completionSteer.readBy.includes("king-ai-ceo"), false);
});
