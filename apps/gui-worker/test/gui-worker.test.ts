/// <reference types="@cloudflare/workers-types" />

import assert from "node:assert/strict";
import { test } from "node:test";
import worker, { GuiState } from "../src/index.js";

type StorageMap = Map<string, unknown>;

class FakeStorage {
  constructor(private readonly map: StorageMap) {}

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
}

function env(initialState?: unknown, extraBindings: Record<string, unknown> = {}): { GUI_STATE: DurableObjectNamespace } & Record<string, unknown> {
  const instances = new Map<string, DurableObjectStub>();
  const createStub = (name: string) => {
    const storage: StorageMap = new Map();
    if (initialState && name === "global") storage.set("state", initialState);
    const state = { storage: new FakeStorage(storage) } as unknown as DurableObjectState;
    const instance = new GuiState(state);
    return {
      fetch: (input: string | URL | Request, init?: RequestInit) => instance.fetch(new Request(input, init))
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
      }
    } as unknown as DurableObjectNamespace,
    ...extraBindings
  };
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) assert.fail(await res.text());
  return (await res.json()) as T;
}

async function pairComputer(
  bindings: { GUI_STATE: DurableObjectNamespace },
  payload: { engines?: string[]; capabilities?: { workspaces?: string[]; agentWorkspaceRoot?: string } } = {}
): Promise<{ computerId: string; deviceToken: string }> {
  const summary = await json<{ pairingCode: string; tenantId?: string }>(
    await worker.fetch(new Request("https://gui/gui/summary"), bindings)
  );
  return json<{ computerId: string; deviceToken: string; tenantId?: string }>(
    await worker.fetch(new Request("https://gui/api/computers/pair", {
      method: "POST",
      body: JSON.stringify({ code: summary.pairingCode, ...payload })
    }), bindings)
  );
}

test("gui runtime isolates state by tenant identity", async () => {
  const bindings = env();
  const aliceHeaders = { "Cf-Access-Authenticated-User-Email": "alice@example.com" };
  const bobHeaders = { "Cf-Access-Authenticated-User-Email": "bob@example.com" };
  const aliceSummary = await json<{ pairingCode: string; pairingLocator: string; tenantId: string; pairCommandTenantArg: string }>(
    await worker.fetch(new Request("https://gui/gui/summary", { headers: aliceHeaders }), bindings)
  );
  const bobSummary = await json<{ pairingCode: string; pairingLocator: string; tenantId: string; pairCommandTenantArg: string }>(
    await worker.fetch(new Request("https://gui/gui/summary", { headers: bobHeaders }), bindings)
  );
  assert.equal(aliceSummary.tenantId, "user-alice-example.com");
  assert.equal(bobSummary.tenantId, "user-bob-example.com");
  assert.notEqual(aliceSummary.pairingCode, bobSummary.pairingCode);
  assert.match(aliceSummary.pairingCode, /^user-alice-example\.com:/);
  assert.match(aliceSummary.pairingLocator, /^king:\/\/pair\?/);
  assert.match(aliceSummary.pairingLocator, /server=https%3A%2F%2Fgui/);
  assert.match(aliceSummary.pairingLocator, /tenant=user-alice-example.com/);
  assert.equal(aliceSummary.pairCommandTenantArg, "");

  const alicePaired = await json<{ deviceToken: string; tenantId: string }>(
    await worker.fetch(new Request("https://gui/api/computers/pair", {
      method: "POST",
      body: JSON.stringify({ code: aliceSummary.pairingCode, engines: ["codex"] })
    }), bindings)
  );
  assert.equal(alicePaired.tenantId, aliceSummary.tenantId);
  await worker.fetch(new Request("https://gui/gui/message", {
    method: "POST",
    headers: aliceHeaders,
    body: JSON.stringify({ body: "alice only" })
  }), bindings);

  const aliceToken = await json<{ token: string }>(
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${alicePaired.deviceToken}`, "X-King-Tenant": aliceSummary.tenantId }
    }), bindings)
  );
  const aliceInbox = await json<{ rows: { body: string }[] }>(
    await worker.fetch(new Request("https://gui/runtime/inbox", {
      headers: { Authorization: `Bearer ${aliceToken.token}`, "X-King-Tenant": aliceSummary.tenantId }
    }), bindings)
  );
  assert.equal(aliceInbox.rows[0]?.body, "alice only");

  const crossTenantToken = await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
    method: "POST",
    headers: { Authorization: `Bearer ${alicePaired.deviceToken}`, "X-King-Tenant": bobSummary.tenantId }
  }), bindings);
  assert.equal(crossTenantToken.status, 401);

  const bobState = await json<{ messages: { body: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state", { headers: bobHeaders }), bindings)
  );
  assert.deepEqual(bobState.messages.map((message) => message.body), []);
});

test("gui requires login when Better Auth is configured", async () => {
  const bindings = env(undefined, {
    AUTH_DB: {} as D1Database,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret"
  });

  const html = await worker.fetch(new Request("https://gui/"), bindings);
  assert.equal(html.status, 401);
  assert.match(await html.text(), /Continue with GitHub/);

  const state = await worker.fetch(new Request("https://gui/gui/state"), bindings);
  assert.equal(state.status, 401);
  assert.deepEqual(await state.json(), { error: "login_required" });
});

test("gui uses Better Auth user identity as tenant", async () => {
  const bindings = env(undefined, {
    AUTH_DB: {} as D1Database,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
    KING_TEST_AUTH_USER: "1"
  });
  const headers = {
    "X-King-Test-User": JSON.stringify({ id: "github-1", email: "octo@example.com", name: "Octo" })
  };

  const page = await worker.fetch(new Request("https://gui/", { headers }), bindings);
  assert.equal(page.status, 200);

  const summary = await json<{ pairingCode: string; pairingLocator: string; tenantId: string; pairCommandTenantArg: string; currentUser?: { id: string; email?: string; name?: string } }>(
    await worker.fetch(new Request("https://gui/gui/summary", { headers }), bindings)
  );
  assert.equal(summary.tenantId, "user-octo-example.com");
  assert.match(summary.pairingCode, /^user-octo-example\.com:/);
  assert.match(summary.pairingLocator, /tenant=user-octo-example.com/);
  assert.equal(summary.pairCommandTenantArg, "");
  assert.deepEqual(summary.currentUser, { id: "github-1", email: "octo@example.com", name: "Octo" });
});

test("gui runtime marks read only through the requested message", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["claude", "codex"] });
  const guiState = await json<{ availableEngines: string[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.deepEqual(guiState.availableEngines, ["claude", "codex"]);

  const tokenRes = await json<{ token: string }>(
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );

  await worker.fetch(new Request("https://gui/gui/message", {
    method: "POST",
    body: JSON.stringify({ body: "first" })
  }), bindings);
  const firstInbox = await json<{ rows: { id: string }[] }>(
    await worker.fetch(new Request("https://gui/runtime/inbox", {
      headers: { Authorization: `Bearer ${tokenRes.token}` }
    }), bindings)
  );
  const firstId = firstInbox.rows[0]?.id;
  assert.equal(typeof firstId, "string");

  await worker.fetch(new Request("https://gui/gui/message", {
    method: "POST",
    body: JSON.stringify({ body: "second" })
  }), bindings);
  await worker.fetch(new Request("https://gui/runtime/conversation/mark-read", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: "king-convo", upToMessageId: firstId })
  }), bindings);

  const inbox = await json<{ rows: { body: string }[]; routeSummary?: string }>(
    await worker.fetch(new Request("https://gui/runtime/inbox", {
      headers: { Authorization: `Bearer ${tokenRes.token}` }
    }), bindings)
  );
  assert.deepEqual(inbox.rows.map((row) => row.body), ["second"]);
  assert.match(inbox.routeSummary ?? "", /respond\/normal\/msg/);
});

test("gui runtime clears messages without clearing paired engines", async () => {
  const bindings = env();
  await pairComputer(bindings, { engines: ["claude", "codex"] });
  await worker.fetch(new Request("https://gui/gui/message", {
    method: "POST",
    body: JSON.stringify({ body: "queued" })
  }), bindings);

  await json<{ ok: true }>(await worker.fetch(new Request("https://gui/gui/clear-messages", {
    method: "POST"
  }), bindings));

  const state = await json<{ availableEngines: string[]; messages: unknown[]; cliLog: unknown[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.deepEqual(state.availableEngines, ["claude", "codex"]);
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.cliLog, []);
});

test("gui can clear only the active conversation window", async () => {
  const bindings = env();
  const created = await json<{ conversation: { id: string } }>(
    await worker.fetch(new Request("https://gui/gui/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "事务窗口" })
    }), bindings)
  );
  await worker.fetch(new Request("https://gui/gui/message", {
    method: "POST",
    body: JSON.stringify({ body: "default window" })
  }), bindings);
  await worker.fetch(new Request("https://gui/gui/message", {
    method: "POST",
    body: JSON.stringify({ body: "clear only me", conversationId: created.conversation.id })
  }), bindings);

  await json<{ ok: true; conversationId: string }>(await worker.fetch(new Request("https://gui/gui/clear-messages", {
    method: "POST",
    body: JSON.stringify({ conversationId: created.conversation.id })
  }), bindings));

  const state = await json<{ messages: { conversation_id: string; body: string; status?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.deepEqual(state.messages.map((row) => [row.conversation_id, row.body, row.status]), [
    ["king-convo", "default window", undefined],
    ["king-convo", "AI 正在处理...", "pending"]
  ]);
});

test("gui supports multiple conversation windows", async () => {
  const bindings = env();
  const created = await json<{ conversation: { id: string; title: string } }>(
    await worker.fetch(new Request("https://gui/gui/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "发布计划" })
    }), bindings)
  );
  assert.equal(created.conversation.title, "发布计划");

  await worker.fetch(new Request("https://gui/gui/message", {
    method: "POST",
    body: JSON.stringify({ body: "default window" })
  }), bindings);
  await worker.fetch(new Request("https://gui/gui/message", {
    method: "POST",
    body: JSON.stringify({ body: "release window", conversationId: created.conversation.id })
  }), bindings);

  const state = await json<{ conversations: { id: string; title: string }[]; messages: { conversation_id: string; body: string; status?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.equal(state.conversations.some((row) => row.id === created.conversation.id && row.title === "发布计划"), true);
  assert.deepEqual(
    state.messages.map((row) => [row.conversation_id, row.body, row.status]),
    [
      ["king-convo", "default window", undefined],
      ["king-convo", "AI 正在处理...", "pending"],
      [created.conversation.id, "release window", undefined],
      [created.conversation.id, "AI 正在处理...", "pending"]
    ]
  );

  const summary = await json<{ conversations: { id: string; messages: number; unread: number }[] }>(
    await worker.fetch(new Request("https://gui/gui/summary"), bindings)
  );
  assert.equal(summary.conversations.find((row) => row.id === created.conversation.id)?.messages, 1);
  assert.equal(summary.conversations.find((row) => row.id === "king-convo")?.messages, 1);
});

test("gui orders new conversation windows near the top", async () => {
  const bindings = env();
  const first = await json<{ conversation: { id: string } }>(
    await worker.fetch(new Request("https://gui/gui/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "旧事务" })
    }), bindings)
  );
  const latest = await json<{ conversation: { id: string } }>(
    await worker.fetch(new Request("https://gui/gui/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "新事务" })
    }), bindings)
  );

  const summary = await json<{ conversations: { id: string; title: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/summary"), bindings)
  );
  const orderedIds = summary.conversations.map((row) => row.id);
  assert.equal(orderedIds[0], "king-convo");
  assert.equal(orderedIds.indexOf(latest.conversation.id) < orderedIds.indexOf(first.conversation.id), true);
});

test("gui can delete non-default conversation windows", async () => {
  const bindings = env();
  const created = await json<{ conversation: { id: string } }>(
    await worker.fetch(new Request("https://gui/gui/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "临时窗口" })
    }), bindings)
  );
  await worker.fetch(new Request("https://gui/gui/message", {
    method: "POST",
    body: JSON.stringify({ conversationId: created.conversation.id, body: "delete me" })
  }), bindings);

  const deleted = await json<{ deleted: boolean }>(
    await worker.fetch(new Request(`https://gui/gui/conversations/${created.conversation.id}/delete`, { method: "POST" }), bindings)
  );
  assert.equal(deleted.deleted, true);

  const state = await json<{ conversations: { id: string }[]; messages: { conversation_id: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.equal(state.conversations.some((row) => row.id === created.conversation.id), false);
  assert.equal(state.messages.some((row) => row.conversation_id === created.conversation.id), false);
});

test("gui runtime exports, imports, and resets durable state snapshots", async () => {
  const bindings = env();
  await pairComputer(bindings, { engines: ["claude", "codex"] });
  await worker.fetch(new Request("https://gui/gui/message", {
    method: "POST",
    body: JSON.stringify({ body: "persist me" })
  }), bindings);

  const exported = await json<{ schema: string; state: { availableEngines: string[]; messages: { body: string }[] } }>(
    await worker.fetch(new Request("https://gui/gui/export-state"), bindings)
  );
  assert.equal(exported.schema, "king.gui-state.v1");
  assert.deepEqual(exported.state.availableEngines, ["claude", "codex"]);
  assert.equal(exported.state.messages[0]?.body, "persist me");

  await json<{ ok: true }>(await worker.fetch(new Request("https://gui/gui/reset-state", { method: "POST" }), bindings));
  const resetState = await json<{ availableEngines: string[]; messages: unknown[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.deepEqual(resetState.availableEngines, []);
  assert.deepEqual(resetState.messages, []);

  await json<{ ok: true; messages: number }>(await worker.fetch(new Request("https://gui/gui/import-state", {
    method: "POST",
    body: JSON.stringify(exported)
  }), bindings));
  const imported = await json<{ availableEngines: string[]; messages: { body: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.deepEqual(imported.availableEngines, ["claude", "codex"]);
  assert.equal(imported.messages[0]?.body, "persist me");

  const bad = await worker.fetch(new Request("https://gui/gui/import-state", {
    method: "POST",
    body: JSON.stringify({ schema: "bad", state: {} })
  }), bindings);
  assert.equal(bad.status, 400);
});

test("gui king state command exports, imports, and resets state snapshots", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  const callCli = async (argv: string[]) => json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}` },
    body: JSON.stringify({ argv })
  }), bindings));

  await worker.fetch(new Request("https://gui/gui/message", {
    method: "POST",
    body: JSON.stringify({ body: "cli snapshot" })
  }), bindings);
  const snapshotText = (await callCli(["state", "export"])).text;
  assert.match(snapshotText, /king\.gui-state\.v1/);

  assert.match((await callCli(["state", "reset"])).text, /"ok":true|"ok": true/);
  assert.match((await callCli(["state", "import", snapshotText])).text, /"messages":2|"messages": 2/);
  const state = await json<{ messages: { body: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.equal(state.messages[0]?.body, "cli snapshot");
});

test("gui runtime lets the page choose agent engine and models", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["claude", "codex"] });
  const beforeToken = await json<{ token: string }>(await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
    method: "POST",
    headers: { Authorization: `Bearer ${paired.deviceToken}` }
  }), bindings));

  await json<{ ok: true }>(await worker.fetch(new Request("https://gui/gui/agent-config", {
    method: "POST",
    body: JSON.stringify({ name: "King Helper", role: "Answer in a concise operator voice.", engine: "claude", lifecycle: "disabled", model: "opus-test", fastModel: "haiku-test" })
  }), bindings));

  const agents = await json<{ name?: string; role?: string; engine?: string; lifecycle?: string; model?: string; fastModel?: string }[]>(
    await worker.fetch(new Request("https://gui/api/computers/me/agents", {
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  assert.equal(agents[0]?.name, "King Helper");
  assert.equal(agents[0]?.role, "Answer in a concise operator voice.");
  assert.equal(agents[0]?.engine, "claude");
  assert.equal(agents[0]?.lifecycle, "disabled");
  assert.equal(agents[0]?.model, "opus-test");
  assert.equal(agents[0]?.fastModel, "haiku-test");

  const state = await json<{ agentConfigUpdatedAt?: number }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.equal(typeof state.agentConfigUpdatedAt, "number");

  const oldTokenStatus = await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${beforeToken.token}` },
    body: JSON.stringify({ argv: ["reply", "king-convo", "stale response"] })
  }), bindings);
  assert.equal(oldTokenStatus.status, 401);

  const afterToken = await json<{ token: string }>(await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
    method: "POST",
    headers: { Authorization: `Bearer ${paired.deviceToken}` }
  }), bindings));
  assert.notEqual(afterToken.token, beforeToken.token);
});

test("gui messages show a pending agent placeholder until runtime reply replaces it", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["claude", "codex"] });
  const token = await json<{ token: string }>(await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
    method: "POST",
    headers: { Authorization: `Bearer ${paired.deviceToken}` }
  }), bindings));

  await worker.fetch(new Request("https://gui/gui/message", {
    method: "POST",
    body: JSON.stringify({ body: "hello" })
  }), bindings);

  let state = await json<{ messages: { author_kind: string; author_engine?: string; body: string; status?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.deepEqual(state.messages.map((row) => [row.author_kind, row.author_engine, row.body, row.status]), [
    ["human", undefined, "hello", undefined],
    ["agent", "codex", "AI 正在处理...", "pending"]
  ]);

  await json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${token.token}` },
    body: JSON.stringify({ agentId: "king-agent", engine: "claude", argv: ["reply", "king-convo", "done"] })
  }), bindings));

  state = await json<{ messages: { author_kind: string; author_engine?: string; body: string; status?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.deepEqual(state.messages.map((row) => [row.author_kind, row.author_engine, row.body, row.status]), [
    ["human", undefined, "hello", undefined],
    ["agent", "claude", "done", "done"]
  ]);
});

test("runtime replies use the executing agent display name", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["claude"] });
  await json<{ ok: true }>(await worker.fetch(new Request("https://gui/gui/agent-config", {
    method: "POST",
    body: JSON.stringify({ name: "Claude Runner", engine: "claude" })
  }), bindings));
  const token = await json<{ token: string }>(await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
    method: "POST",
    headers: { Authorization: `Bearer ${paired.deviceToken}` }
  }), bindings));

  await json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${token.token}` },
    body: JSON.stringify({ agentId: "king-agent", engine: "codex", argv: ["reply", "king-convo", "hello"] })
  }), bindings));

  const state = await json<{ messages: { author_name: string; author_kind: string; author_engine?: string; body: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.deepEqual(state.messages.map((row) => [row.author_name, row.author_kind, row.author_engine, row.body]), [["Claude Runner", "agent", "codex", "hello"]]);
});

test("runtime reply engine prefers the active run engine over stale shim payloads", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["claude", "codex"] });
  const token = await json<{ token: string }>(await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
    method: "POST",
    headers: { Authorization: `Bearer ${paired.deviceToken}` }
  }), bindings));

  await worker.fetch(new Request("https://gui/gui/message", {
    method: "POST",
    body: JSON.stringify({ body: "which engine" })
  }), bindings);
  await worker.fetch(new Request("https://gui/runtime/runs", {
    method: "POST",
    headers: { Authorization: `Bearer ${token.token}` },
    body: JSON.stringify({ trigger: { source: "wake", engine: "claude" } })
  }), bindings);
  await json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${token.token}` },
    body: JSON.stringify({ agentId: "king-agent", engine: "codex", argv: ["reply", "king-convo", "from claude"] })
  }), bindings));

  const state = await json<{ messages: { author_engine?: string; body: string; status?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.deepEqual(state.messages.map((row) => [row.author_engine, row.body, row.status]), [
    [undefined, "which engine", undefined],
    ["claude", "from claude", "done"]
  ]);
});

test("runtime replies fall back to the default agent for unknown agent ids", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["claude"] });
  const token = await json<{ token: string }>(await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
    method: "POST",
    headers: { Authorization: `Bearer ${paired.deviceToken}` }
  }), bindings));

  await json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${token.token}` },
    body: JSON.stringify({ agentId: "missing-agent", argv: ["reply", "king-convo", "hello"] })
  }), bindings));

  const state = await json<{ messages: { author_name: string; author_engine?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.equal(state.messages[0]?.author_name, "King Agent");
  assert.equal(state.messages[0]?.author_engine, "codex");
});

test("gui runtime records computer capabilities from pair and heartbeat", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"], capabilities: { workspaces: ["/Users/fayon/workspace/github"], agentWorkspaceRoot: "/tmp/agents" } });

  let state = await json<{ capabilities: { workspaces: string[]; agentWorkspaceRoot?: string } }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.deepEqual(state.capabilities.workspaces, ["/Users/fayon/workspace/github"]);
  assert.equal(state.capabilities.agentWorkspaceRoot, "/tmp/agents");

  await json<{ ok: true }>(await worker.fetch(new Request("https://gui/api/computers/heartbeat", {
    method: "POST",
    headers: { Authorization: `Bearer ${paired.deviceToken}` },
    body: JSON.stringify({ version: "0.1.0", capabilities: { workspaces: ["/tmp/project"], agentWorkspaceRoot: "/tmp/runtime-agents" } })
  }), bindings));

  const heartbeatState = await json<{ capabilities: { workspaces: string[]; agentWorkspaceRoot?: string }; lastHeartbeat?: { version?: string } }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.deepEqual(heartbeatState.capabilities.workspaces, ["/tmp/project"]);
  assert.equal(heartbeatState.capabilities.agentWorkspaceRoot, "/tmp/runtime-agents");
  assert.equal(heartbeatState.lastHeartbeat?.version, "0.1.0");
});

test("gui runtime requires the generated pairing code", async () => {
  const bindings = env();
  const summary = await json<{ pairingCode: string }>(
    await worker.fetch(new Request("https://gui/gui/summary"), bindings)
  );
  assert.match(summary.pairingCode, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  const invalid = await worker.fetch(new Request("https://gui/api/computers/pair", {
    method: "POST",
    body: JSON.stringify({ code: "gui", engines: ["codex"] })
  }), bindings);
  assert.equal(invalid.status, 401);

  await pairComputer(bindings, { engines: ["codex"] });
  const state = await json<{ availableEngines: string[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.deepEqual(state.availableEngines, ["codex"]);
});

test("gui runtime persists generated pairing code for older stored state", async () => {
  const sourceBindings = env();
  const oldState = await json<Record<string, unknown>>(
    await worker.fetch(new Request("https://gui/gui/state"), sourceBindings)
  );
  delete oldState.pairingCode;

  const bindings = env(oldState);
  const first = await json<{ pairingCode: string }>(
    await worker.fetch(new Request("https://gui/gui/summary"), bindings)
  );
  const second = await json<{ pairingCode: string }>(
    await worker.fetch(new Request("https://gui/gui/summary"), bindings)
  );

  assert.match(first.pairingCode, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(second.pairingCode, first.pairingCode);
});

test("gui page exposes channel chat shell with settings modal", async () => {
  const page = await worker.fetch(new Request("https://gui/"), env());
  const html = await page.text();
  assert.match(html, /King Chat/);
  assert.match(html, /Channels/);
  assert.match(html, /# all/);
  assert.match(html, /id="chatWindow"/);
  assert.match(html, /id="settingsDialog"/);
  assert.match(html, /function currentHumanName/);
  assert.match(html, /id="computerDialog"/);
  assert.match(html, /id="newWindowDialog"/);
  assert.match(html, /id="newWindowTitle"/);
  assert.match(html, /function submitConversation/);
  assert.doesNotMatch(html, /prompt\('Window name'\)/);
  assert.match(html, /function openSettings/);
  assert.match(html, /function openComputerFlow/);
  assert.match(html, /grid-template-columns:\s*42px 180px minmax\(0, 1fr\)/);
  assert.match(html, /class="windows"/);
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
  assert.match(html, /body\.mobile-layout \.rail[\s\S]*display:\s*none/);
  assert.match(html, /body\.mobile-layout \.hide-mobile[\s\S]*display:\s*inline-block !important/);
  assert.match(html, /matchMedia\('\(max-width:\s*760px\)'\)/);
  assert.match(html, /window-delete/);
  assert.match(html, /function deleteConversation/);
  assert.match(html, /id="clearButton"/);
  assert.match(html, /function clearMessages/);
  assert.match(html, /renderMessages = function/);
  assert.match(html, /class="engine-chip"/);
  assert.match(html, /message\.author_engine/);
  assert.doesNotMatch(html, /<span class="author">AI<\/span><span class="time">now<\/span>/);
  assert.match(html, /等待本地 agent 回复/);
  assert.match(html, /agent 正在处理/);
  assert.match(html, /typing-dots/);
  assert.match(html, /second:\s*'2-digit'/);
  assert.match(html, /height:\s*100vh/);
  assert.match(html, /body\s*\{[\s\S]*overflow:\s*hidden/);
  assert.match(html, /aria-label="King"><span>K<\/span><\/div>/);
  assert.doesNotMatch(html, /<span>I<\/span><span>N<\/span><span>G<\/span>/);
  assert.match(html, /Model status/);
  assert.match(html, /Agent persona/);
  assert.match(html, /id="agentName"/);
  assert.match(html, /id="agentRole"/);
  assert.match(html, /id="modelStatus"/);
  assert.match(html, /Message #all/);
  assert.doesNotMatch(html, /agent 电脑怎么弄/);
  assert.match(html, /id="sendButton"/);
  assert.match(html, /button\.textContent = 'Sending'/);
  assert.doesNotMatch(html, /<span class="author">AI<\/span><span class="time">soon<\/span>/);
  assert.doesNotMatch(html, /已唤醒，等待本地 Claude\/Codex 回复/);
  assert.match(html, /Add a Computer/);
  assert.match(html, /Your Computer/);
  assert.match(html, /Connect Computer/);
  assert.match(html, /First-time pairing/);
  assert.match(html, /Already paired/);
  assert.match(html, /Waiting for computer to connect/);
  assert.match(html, /Waiting for it to come online/);
  assert.match(html, /Apply/);
  assert.match(html, /Add computer/);
  assert.match(html, /\/gui\/summary/);
  assert.match(html, /showPanel\((?:'|&#39;)tasks(?:'|&#39;)\)/);
  assert.match(html, /function updateBackToBottom/);
  assert.match(html, /summary\.pairingCode/);
  assert.match(html, /summary\.pairingLocator/);
  assert.match(html, /king agent computer --pair/);
  assert.match(html, /pairCommandStart = 'king agent computer'/);
  assert.doesNotMatch(html, /Computer pairing/);
  assert.doesNotMatch(html, /--pair gui/);
  assert.doesNotMatch(html, /id="state"/);
  assert.doesNotMatch(html, /King 本地 Agent 控制台/);
});

test("gui ui summary and activity endpoints aggregate console state", async () => {
  const bindings = env();
  await pairComputer(bindings, { engines: ["codex"], capabilities: { workspaces: ["/tmp/project"] } });
  await worker.fetch(new Request("https://gui/gui/message", {
    method: "POST",
    body: JSON.stringify({ body: "inspect this" })
  }), bindings);
  await worker.fetch(new Request("https://gui/gui/task", {
    method: "POST",
    body: JSON.stringify({ title: "Console task", description: "verify summary", paths: "apps/gui-worker/src/index.ts" })
  }), bindings);

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
  assert.equal(summary.observation.counts.activeTasks, 1);
  assert.match(summary.routeSummary, /respond\/normal\/msg/);

  const activity = await json<{ rows: { type: string; summary: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/activity?limit=10"), bindings)
  );
  assert.ok(activity.rows.some((row) => row.type === "message.human" && row.summary.includes("inspect this")));
  assert.ok(activity.rows.some((row) => row.type === "queue.backlog"));
});

test("gui ui can update tasks, move cards, and mark a conversation read", async () => {
  const bindings = env();
  await worker.fetch(new Request("https://gui/gui/message", {
    method: "POST",
    body: JSON.stringify({ body: "read me" })
  }), bindings);
  const createdTask = await json<{ task: { id: string; status: string } }>(
    await worker.fetch(new Request("https://gui/gui/task", {
      method: "POST",
      body: JSON.stringify({ title: "Move task", wake: false })
    }), bindings)
  );
  assert.equal(createdTask.task.status, "assigned");

  const updatedTask = await json<{ task: { status: string } }>(
    await worker.fetch(new Request(`https://gui/gui/task/${createdTask.task.id}/update`, {
      method: "POST",
      body: JSON.stringify({ status: "done", result: "ok" })
    }), bindings)
  );
  assert.equal(updatedTask.task.status, "done");

  const createdCard = await json<{ card: { id: string; column: string } }>(
    await worker.fetch(new Request("https://gui/gui/card", {
      method: "POST",
      body: JSON.stringify({ title: "Move card", allowedPaths: ["apps/gui-worker"] })
    }), bindings)
  );
  const movedCard = await json<{ card: { column: string } }>(
    await worker.fetch(new Request(`https://gui/gui/card/${createdCard.card.id}/move`, {
      method: "POST",
      body: JSON.stringify({ column: "doing" })
    }), bindings)
  );
  assert.equal(movedCard.card.column, "doing");

  await json<{ ok: true }>(await worker.fetch(new Request("https://gui/gui/conversation/mark-read", {
    method: "POST",
    body: JSON.stringify({ conversationId: "king-convo" })
  }), bindings));
  const summary = await json<{ observation: { counts: { unreadMessages: number } } }>(
    await worker.fetch(new Request("https://gui/gui/summary"), bindings)
  );
  assert.equal(summary.observation.counts.unreadMessages, 0);
});

test("gui runtime supports broader king CLI commands", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["claude", "codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  await worker.fetch(new Request("https://gui/gui/message", {
    method: "POST",
    body: JSON.stringify({ body: "hello" })
  }), bindings);

  const callCli = async (argv: string[]) => json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}` },
    body: JSON.stringify({ argv })
  }), bindings));

  assert.match((await callCli(["messages", "king-convo"])).text, /hello/);
  assert.match((await callCli(["messages", "king-convo", "--tail", "1"])).text, /hello/);
  assert.match((await callCli(["glance", "king-convo"])).text, /King Human: hello/);
  assert.match((await callCli(["agents"])).text, /Agent Matrix:/);
  assert.match((await callCli(["agents"])).text, /king-agent\s+idle\s+on-demand\s+codex/);
  assert.match((await callCli(["agents", "spawn", "king-agent", "king-agent-2"])).text, /not supported/);
  assert.match((await callCli(["roster"])).text, /king-agent\tKing Agent\tLocal BYOA agent\tengine=codex\tlifecycle=on-demand\tstatus=idle/);
  assert.match((await callCli(["participants"])).text, /unread=1/);
  assert.match((await callCli(["contacts", "operator"])).text, /gui-human\tKing Human\thuman\tRuntime operator/);
  assert.match((await callCli(["whoami"])).text, /"status": "idle"/);
  assert.match((await callCli(["status"])).text, /"agentState"/);
  assert.match((await callCli(["status"])).text, /availableEngines/);
  assert.match((await callCli(["help"])).text, /king contacts/);
  assert.match((await callCli(["help"])).text, /king agents \[spawn\|destroy\]/);
  assert.match((await callCli(["help"])).text, /king card list\|create\|claim\|move\|done\|release/);
  assert.match((await callCli(["help"])).text, /--paths a,b/);
  assert.match((await callCli(["help"])).text, /king initiative create\|list\|get\|update/);
  assert.match((await callCli(["help"])).text, /king capsule create\|list\|mine\|get\|update/);
  assert.match((await callCli(["help"])).text, /king send <agentId> <message>/);
  assert.match((await callCli(["help"])).text, /king recv \[--agent agent-id\]/);
  assert.match((await callCli(["help"])).text, /king escalate <message>/);
  assert.match((await callCli(["help"])).text, /king observe \[--json\]/);
  assert.match((await callCli(["help"])).text, /king context get\|set\|list\|delete/);
  assert.match((await callCli(["help"])).text, /king hypothesis create\|list\|update/);
});

test("gui runtime supports send, recv, and escalate message relay commands", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  const callCli = async (argv: string[]) => json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}` },
    body: JSON.stringify({ argv })
  }), bindings));

  assert.match((await callCli(["send", "teammate", "please", "review", "--type", "decision", "--steer"])).text, /queued -> teammate \(decision, steer\)/);
  const firstRecv = await callCli(["recv", "--agent", "teammate"]);
  assert.match(firstRecv.text, /\[steer\/steer\/decision\] King Agent .*please review/);
  assert.match((await callCli(["recv", "--agent", "teammate"])).text, /No pending messages/);

  assert.match((await callCli(["send", "teammate", "blocked", "on", "API", "--type", "blocker"])).text, /queued -> teammate \(blocker, normal\)/);
  assert.match((await callCli(["recv", "--agent", "teammate"])).text, /\[steer\/urgent\/blocker\] King Agent .*blocked on API/);

  assert.match((await callCli(["dm", "teammate", "private", "note"])).text, /dm posted dm-king-agent-teammate/);
  assert.match((await callCli(["recv", "--agent", "other-agent"])).text, /No pending messages/);
  assert.match((await callCli(["recv", "--agent", "teammate"])).text, /\[steer\/normal\/msg\] King Agent .*private note/);

  assert.match((await callCli(["escalate", "need", "human", "choice"])).text, /Escalated to king-agent: msg-.*\(queued\)/);
  assert.match((await callCli(["recv"])).text, /\[steer\/steer\/decision\] King Agent .*need human choice/);

  assert.match((await callCli(["send", "teammate", "normal", "followup"])).text, /queued -> teammate \(message, normal\)/);
  assert.match((await callCli(["send", "teammate", "urgent", "blocker", "--type", "blocker"])).text, /queued -> teammate \(blocker, normal\)/);
  const priorityRecv = await callCli(["recv", "--agent", "teammate"]);
  assert.match(priorityRecv.text, /^\[steer\/urgent\/blocker\].*urgent blocker/m);
  assert.match(priorityRecv.text, /\[steer\/normal\/msg\].*normal followup/);

  const state = await json<{ messages: { body: string; priority?: string; message_type?: string; to_agent_id?: string; readBy: string[] }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.equal(state.messages.some((row) =>
    row.body === "please review" &&
    row.priority === "steer" &&
    row.message_type === "decision" &&
    row.to_agent_id === "teammate" &&
    row.readBy.includes("teammate")
  ), true);
});

test("gui runtime routes external events to subscribed agents", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  const auth = { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" };
  const callCli = async (argv: string[]) => json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}` },
    body: JSON.stringify({ argv })
  }), bindings));

  assert.match((await callCli(["route", "set", "github_issue", "--agent", "feedback"])).text, /route set github_issue -> feedback/);
  assert.match((await callCli(["route", "set", "shared_event", "--agent", "feedback"])).text, /route set shared_event -> feedback/);
  assert.match((await callCli(["route", "set", "shared_event", "--agent", "devops"])).text, /route set shared_event -> devops/);
  assert.match((await callCli(["route", "list"])).text, /github_issue\t-> feedback/);

  assert.match((await callCli(["route", "emit", "github_issue", "--source", "github", "{\"title\":\"Login broken\"}"])).text, /event routed github_issue -> feedback/);
  assert.match((await callCli(["recv", "--agent", "feedback"])).text, /\[steer\/normal\/msg\] Runtime Event .*github_issue.*Login broken/);
  assert.match((await callCli(["recv", "--agent", "devops"])).text, /No pending messages/);

  assert.match((await callCli(["route", "emit", "shared_event", "--source", "test", "{\"data\":\"broadcast\"}"])).text, /event routed shared_event -> devops,feedback/);
  assert.match((await callCli(["recv", "--agent", "feedback"])).text, /shared_event.*broadcast/);
  assert.match((await callCli(["recv", "--agent", "devops"])).text, /shared_event.*broadcast/);
  assert.match((await callCli(["route", "emit", "unknown_event", "--source", "test", "{}"])).text, /event ignored unknown_event/);

  const eventRes = await json<{ routed: string[] }>(await worker.fetch(new Request("https://gui/runtime/events", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ type: "github_issue", source: "github", payload: { title: "Billing broken" } })
  }), bindings));
  assert.deepEqual(eventRes.routed, ["feedback"]);
  assert.match((await callCli(["recv", "--agent", "feedback"])).text, /Billing broken/);

  const state = await json<{ eventRoutes: { eventType: string; agentId: string }[]; agents: { id: string; events?: string[] }[]; messages: { to_agent_id?: string; payload?: { type?: string; payload?: { title?: string } } }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.deepEqual(state.eventRoutes.map((route) => `${route.eventType}->${route.agentId}`).sort(), [
    "github_issue->feedback",
    "shared_event->devops",
    "shared_event->feedback"
  ]);
  assert.deepEqual(state.agents.find((agent) => agent.id === "feedback")?.events?.sort(), ["github_issue", "shared_event"]);
  assert.equal(state.messages.some((message) =>
    message.to_agent_id === "feedback" &&
    message.payload?.type === "github_issue" &&
    message.payload.payload?.title === "Billing broken"
  ), true);
  assert.match((await callCli(["route", "delete", "github_issue", "--agent", "feedback"])).text, /route deleted github_issue -> feedback/);
});

test("gui runtime records status, typing, thinking, events, and runs", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["claude"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  const auth = { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" };

  await worker.fetch(new Request("https://gui/runtime/status", { method: "POST", headers: auth, body: JSON.stringify({ status: "thinking" }) }), bindings);
  await worker.fetch(new Request("https://gui/runtime/typing", { method: "POST", headers: auth, body: JSON.stringify({ conversationId: "king-convo", done: false }) }), bindings);
  await worker.fetch(new Request("https://gui/runtime/thinking/mark", { method: "POST", headers: auth, body: JSON.stringify({ conversationIds: ["king-convo"] }) }), bindings);
  await worker.fetch(new Request("https://gui/runtime/events", { method: "POST", headers: auth, body: JSON.stringify({ kind: "gui.event" }) }), bindings);
  await worker.fetch(new Request("https://gui/runtime/notices", { method: "POST", headers: auth, body: JSON.stringify({ noticeKind: "byoa_engine_failed" }) }), bindings);
  await worker.fetch(new Request("https://gui/runtime/triage", { method: "POST", headers: auth, body: JSON.stringify({ source: "byoa-codex", actionable: true }) }), bindings);
  const run = await json<{ runId: string }>(await worker.fetch(new Request("https://gui/runtime/runs", { method: "POST", headers: auth, body: JSON.stringify({ trigger: "test" }) }), bindings));
  await worker.fetch(new Request(`https://gui/runtime/runs/${run.runId}/heartbeat`, { method: "POST", headers: auth }), bindings);
  await worker.fetch(new Request(`https://gui/runtime/runs/${run.runId}/finish`, { method: "POST", headers: auth, body: JSON.stringify({ status: "completed" }) }), bindings);
  await worker.fetch(new Request("https://gui/runtime/thinking/unmark", { method: "POST", headers: auth, body: JSON.stringify({ conversationIds: ["king-convo"] }) }), bindings);

  const state = await json<{
    statusLog: { status: string }[];
    typingLog: { conversationId?: string }[];
    thinkingLog: { action: string }[];
    eventLog: { body: { kind?: string } }[];
    noticeLog: { body: { noticeKind?: string } }[];
    triageLog: { body: { source?: string } }[];
    runLog: { action: string }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.equal(state.statusLog.at(-1)?.status, "thinking");
  assert.equal(state.typingLog.at(-1)?.conversationId, "king-convo");
  assert.deepEqual(state.thinkingLog.map((row) => row.action), ["mark", "unmark"]);
  assert.equal(state.eventLog.at(-1)?.body.kind, "gui.event");
  assert.equal(state.noticeLog.at(-1)?.body.noticeKind, "byoa_engine_failed");
  assert.equal(state.triageLog.at(-1)?.body.source, "byoa-codex");
  assert.deepEqual(state.runLog.map((row) => row.action), ["start", "heartbeat", "finish"]);
});

test("gui runtime rejects unauthenticated state mutations", async () => {
  const bindings = env();
  await pairComputer(bindings, { engines: ["claude"] });

  const statusRes = await worker.fetch(new Request("https://gui/runtime/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "spoofed" })
  }), bindings);
  assert.equal(statusRes.status, 401);

  const eventRes = await worker.fetch(new Request("https://gui/runtime/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "spoofed.event" })
  }), bindings);
  assert.equal(eventRes.status, 401);

  const runRes = await worker.fetch(new Request("https://gui/runtime/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trigger: "spoofed" })
  }), bindings);
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
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  const auth = { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" };
  const callCli = async (argv: string[]) => json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}` },
    body: JSON.stringify({ argv })
  }), bindings));

  assert.match((await callCli(["observe"])).text, /classification=idle/);

  await worker.fetch(new Request("https://gui/gui/message", {
    method: "POST",
    body: JSON.stringify({ body: "pending work" })
  }), bindings);
  assert.match((await callCli(["observe"])).text, /classification=backlog_stuck/);
  assert.match((await callCli(["observe", "--classification", "productive"])).text, /No observe snapshot matching classification=productive/);
  assert.match((await callCli(["recv"])).text, /pending work/);

  const prerequisite = await callCli(["task", "create", "Prerequisite"]);
  const prerequisiteId = prerequisite.text.match(/Task (task-[^ ]+) created/)?.[1];
  assert.equal(typeof prerequisiteId, "string");
  await callCli(["task", "create", "Blocked followup", "--after", prerequisiteId ?? ""]);
  assert.match((await callCli(["observe"])).text, /classification=blocked/);

  const taskState = await json<{ tasks: { id: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.equal(taskState.tasks.length, 2);
  await callCli(["task", "update", taskState.tasks[1]?.id ?? "", "--status", "review"]);
  const productive = await callCli(["observe", "--json"]);
  assert.match(productive.text, /"classification": "productive"/);
  assert.match(productive.text, /"activeTasks": 2/);

  const run = await json<{ runId: string }>(await worker.fetch(new Request("https://gui/runtime/runs", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ trigger: "observe-test" })
  }), bindings));
  await worker.fetch(new Request(`https://gui/runtime/runs/${run.runId}/finish`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ status: "failed" })
  }), bindings);
  assert.match((await callCli(["observe"])).text, /classification=error/);
  assert.match((await callCli(["watch", "--json"])).text, /"failedRuns": 1/);
});

test("gui runtime records King loop events", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  const callCli = async (argv: string[]) => json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}` },
    body: JSON.stringify({ argv })
  }), bindings));

  assert.match((await callCli(["loop", "snapshot"])).text, /classification=idle/);
  assert.match((await callCli(["loop", "tick", "--run", "run-test"])).text, /loop tick 1 run=run-test/);
  assert.match((await callCli(["loop", "emit", "queue.backlog", "--agent", "feedback", "--pending", "2", "{\"source\":\"manual\"}"])).text, /loop event queue.backlog recorded loop=1/);
  assert.match((await callCli(["loop", "classify"])).text, /loop classified backlog_stuck/);
  assert.match((await callCli(["loop", "recent", "--type", "queue.backlog"])).text, /queue\.backlog agent=feedback pending=2/);

  assert.match((await callCli(["route", "set", "github_issue", "--agent", "feedback"])).text, /route set github_issue -> feedback/);
  assert.match((await callCli(["route", "emit", "github_issue", "--source", "github", "{\"title\":\"Loop backlog\"}"])).text, /event routed github_issue -> feedback/);
  assert.match((await callCli(["loop", "recent", "--agent", "feedback"])).text, /queue\.backlog agent=feedback pending=1/);

  const task = await callCli(["task", "create", "Loop task", "--assign", "king-agent"]);
  const taskId = task.text.match(/Task (task-[^ ]+) created/)?.[1];
  assert.equal(typeof taskId, "string");
  assert.match((await callCli(["task", "update", taskId ?? "", "--status", "review"])).text, /updated \[review\]/);
  assert.match((await callCli(["artifact", "put", "--kind", "tech_spec", "--path", "gui/loop/spec", "--source", "repo:gui", "--confidence", "0.9", "--task", taskId ?? "", "{\"date\":\"2026-06-03\"}"])).text, /artifact stored/);
  assert.match((await callCli(["loop", "classify"])).text, /loop classified productive/);

  const recent = await callCli(["loop", "recent", "--json"]);
  assert.match(recent.text, /"type": "task.transition"/);
  assert.match(recent.text, /"type": "artifact.created"/);
  assert.match(recent.text, /"type": "loop.classified"/);

  const state = await json<{ loopRunId: string; currentLoop: number; loopEvents: { type: string; loop: number }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.equal(state.loopRunId, "run-test");
  assert.equal(state.currentLoop, 1);
  assert.equal(state.loopEvents.some((event) => event.type === "artifact.created" && event.loop === 1), true);
});

test("gui runtime exposes King runtime preambles", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  const callCli = async (argv: string[]) => json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}` },
    body: JSON.stringify({ argv })
  }), bindings));

  assert.match((await callCli(["loop", "tick", "--run", "run-preamble"])).text, /loop tick 1/);
  assert.match((await callCli(["task", "create", "Summarize runtime", "--assign", "king-agent"])).text, /Task task-/);
  assert.match((await callCli(["context", "set", "decision", "prefer", "runtime", "preamble"])).text, /prefer runtime preamble/);
  await worker.fetch(new Request("https://gui/gui/message", {
    method: "POST",
    body: JSON.stringify({ body: "please summarize current state" })
  }), bindings);

  const preamble = await json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/preamble?agent=king-agent&reason=wake&runId=run-preamble", {
    headers: { Authorization: `Bearer ${tokenRes.token}` }
  }), bindings));
  assert.match(preamble.text, /Runtime Context \(Loop #1\)/);
  assert.match(preamble.text, /Run ID: run-preamble/);
  assert.match(preamble.text, /Current Tasks/);
  assert.match(preamble.text, /Summarize runtime/);
  assert.match(preamble.text, /Recent Unread Messages/);
  assert.match(preamble.text, /please summarize current state/);
  assert.match(preamble.text, /Shared Context/);
  assert.match(preamble.text, /decision: prefer runtime preamble/);

  const cliPreamble = await callCli(["preamble", "--agent", "king-agent", "--reason", "agenda", "--run", "run-preamble"]);
  assert.match(cliPreamble.text, /Reason: agenda/);
  assert.match(cliPreamble.text, /Run ID: run-preamble/);
});

test("gui runtime supports board, calendar, claims, roster, and agenda", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["claude", "codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  const callCli = async (argv: string[]) => json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}` },
    body: JSON.stringify({ argv })
  }), bindings));

  assert.match((await callCli(["card", "create", "Ship gui board"])).text, /card created/);
  const stateWithCard = await json<{ cards: { id: string }[] }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const cardId = stateWithCard.cards[0]?.id;
  assert.equal(typeof cardId, "string");
  assert.match((await callCli(["card", "claim", cardId])).text, /card claimed/);
  assert.match((await callCli(["card", "release", cardId])).text, /card released/);
  assert.match((await callCli(["card", "claim", cardId])).text, /card claimed/);
  assert.match((await callCli(["card", "done", cardId])).text, /card moved/);
  assert.match((await callCli(["calendar", "create", "Followup", "--at", "2000-01-01T00:00:00.000Z", "--assignee", "king-agent", "--prompt", "check board"])).text, /calendar created/);
  assert.match((await callCli(["claim", "gui-work", "--in", "king-convo"])).text, /claim created/);
  assert.match((await callCli(["unclaim", "gui-work"])).text, /claim released/);

  await worker.fetch(new Request("https://gui/gui/card", {
    method: "POST",
    body: JSON.stringify({ title: "Agenda card", assignee: "king-agent" })
  }), bindings);
  const agenda = await json<{ actionable: boolean; brief: string }>(
    await worker.fetch(new Request("https://gui/runtime/agenda", {
      headers: { Authorization: `Bearer ${tokenRes.token}` }
    }), bindings)
  );
  assert.equal(agenda.actionable, true);
  assert.match(agenda.brief, /Agenda card|Calendar due/);

  await worker.fetch(new Request("https://gui/runtime/status", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}` },
    body: JSON.stringify({ status: "thinking" })
  }), bindings);

  const roster = await json<{ roster: string; agentStates: { id: string; status: string; lifecycle: string; engine: string }[] }>(
    await worker.fetch(new Request("https://gui/runtime/roster", {
      headers: { Authorization: `Bearer ${tokenRes.token}` }
    }), bindings)
  );
  assert.match(roster.roster, /king-agent/);
  assert.match(roster.roster, /status=thinking/);
  assert.equal(roster.agentStates[0]?.id, "king-agent");
  assert.equal(roster.agentStates[0]?.status, "thinking");
  assert.equal(roster.agentStates[0]?.lifecycle, "on-demand");
  assert.equal(roster.agentStates[0]?.engine, "codex");
});

test("gui runtime supports cron-backed calendar agenda items", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  const callCli = async (argv: string[]) => json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}` },
    body: JSON.stringify({ argv })
  }), bindings));

  const now = new Date();
  const expression = `${now.getMinutes()} ${now.getHours()} * * *`;
  assert.match((await callCli(["calendar", "create", "CronCheck", "--at", "2999-01-01T00:00:00.000Z", "--cron", expression, "--prompt", "cron wake"])).text, /cron=/);
  assert.match((await callCli(["calendar", "create", "BadCron", "--cron", "*/0 * * * *"])).text, /Invalid step/);

  const agenda = await json<{ actionable: boolean; brief: string }>(
    await worker.fetch(new Request("https://gui/runtime/agenda", {
      headers: { Authorization: `Bearer ${tokenRes.token}` }
    }), bindings)
  );
  assert.equal(agenda.actionable, true);
  assert.match(agenda.brief, /CronCheck \[cron/);
  assert.match(agenda.brief, /cron wake/);
});

test("gui runtime supports task pool commands with dependencies", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  const callCli = async (argv: string[]) => json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}` },
    body: JSON.stringify({ argv })
  }), bindings));

  const first = await callCli(["task", "create", "Build foundation", "--assign", "king-agent", "--priority", "2", "--path", "src/runtime"]);
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
  assert.match((await callCli(["task", "update", secondId ?? "", "--assign", "king-agent", "--status", "review", "--result", "ready"])).text, /\[review\]/);
  assert.match((await callCli(["task", "done", firstId ?? "", "foundation", "ready"])).text, /marked done/);
  assert.match((await callCli(["task", "list"])).text, /\[review\].*Ship feature/);

  const roster = await callCli(["roster"]);
  assert.match(roster.text, /tasks=1/);
});

test("gui runtime supports initiative board links across tasks and capsules", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  const callCli = async (argv: string[]) => json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}` },
    body: JSON.stringify({ argv })
  }), bindings));

  const created = await callCli([
    "initiative", "create",
    "Advance roadmap",
    "--goal", "Ship the next roadmap milestone",
    "--summary", "Prioritize external value",
    "--priority", "9",
    "--source", "README.md,docs/ROADMAP.md"
  ]);
  assert.match(created.text, /Initiative initiative-.*created: "Advance roadmap" \[active\]/);
  const initiativeId = created.text.match(/Initiative (initiative-[^ ]+) created/)?.[1];
  assert.equal(typeof initiativeId, "string");

  const task = await callCli(["task", "create", "Build roadmap endpoint", "--assign", "dev", "--initiative", initiativeId ?? "", "--subsystem", "roadmap-api"]);
  assert.match(task.text, /Task task-/);
  const taskId = task.text.match(/Task (task-[^ ]+) created/)?.[1];
  assert.equal(typeof taskId, "string");
  assert.match((await callCli(["task", "list", "--initiative", initiativeId ?? ""])).text, /I:initiati.*subsystem=roadmap-api/);

  const capsule = await callCli([
    "capsule", "create",
    "--goal", "Implement roadmap endpoint",
    "--owner", "dev",
    "--paths", "src/roadmap.ts",
    "--acceptance", "endpoint tested",
    "--initiative", initiativeId ?? "",
    "--task", taskId ?? ""
  ]);
  const capsuleId = capsule.text.match(/Capsule (capsule-[^ ]+) created/)?.[1];
  assert.equal(typeof capsuleId, "string");

  assert.match((await callCli(["initiative", "list", "--status", "active"])).text, /P9 "Advance roadmap" - Prioritize external value tasks=1 capsules=1/);
  const detail = await callCli(["initiative", "get", initiativeId ?? ""]);
  assert.match(detail.text, /"taskCount": 1/);
  assert.match(detail.text, /"capsuleCount": 1/);
  assert.match(detail.text, /"sources": \[/);

  assert.match((await callCli(["initiative", "update", initiativeId ?? "", "--status", "paused", "--summary", "Scope adjusted", "--priority", "4"])).text, /\[paused\]/);
  const state = await json<{ initiatives: { id: string; status: string; priority: number; summary?: string }[]; tasks: { initiativeId?: string }[]; capsules: { initiativeId?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
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
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  const callCli = async (argv: string[]) => json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}` },
    body: JSON.stringify({ argv })
  }), bindings));

  const task = await callCli(["task", "create", "Fix webhook ingestion", "--assign", "dev"]);
  const taskId = task.text.match(/Task (task-[^ ]+) created/)?.[1];
  assert.equal(typeof taskId, "string");

  const created = await callCli([
    "capsule", "create",
    "--goal", "Fix webhook ingestion",
    "--owner", "dev",
    "--branch", "king/dev/webhook",
    "--base", "abc123",
    "--paths", "apps/api/src/routes/webhooks.ts,apps/api/src/routes/webhooks.test.ts",
    "--acceptance", "webhook forwards payload and tests pass",
    "--task", taskId ?? "",
    "--reviewer", "cto",
    "--subsystem", "api-webhooks",
    "--scope-type", "code"
  ]);
  assert.match(created.text, /Capsule capsule-.*created on king\/dev\/webhook \[open\]/);
  const capsuleId = created.text.match(/Capsule (capsule-[^ ]+) created/)?.[1];
  assert.equal(typeof capsuleId, "string");

  assert.match((await callCli(["capsule", "list", "--status", "open", "--owner", "dev", "--reviewer", "cto"])).text, /\[open\].*dev king\/dev\/webhook "Fix webhook ingestion".*reviewer=cto.*subsystem=api-webhooks/);
  assert.match((await callCli(["capsule", "mine", "--agent", "dev"])).text, /acceptance: webhook forwards payload and tests pass/);
  assert.match((await callCli(["capsule", "get", capsuleId ?? ""])).text, /"scopeType": "code"/);

  const weakConflict = await callCli([
    "capsule", "create",
    "--goal", "Document webhook behavior",
    "--owner", "docs",
    "--paths", "apps/api/src/routes/README.md",
    "--subsystem", "api-webhooks",
    "--acceptance", "docs updated"
  ]);
  assert.match(weakConflict.text, /Conflicts: capsule-.*\(weak_conflict\)/);

  const highConflict = await callCli([
    "capsule", "create",
    "--goal", "Patch webhook handler",
    "--owner", "qa",
    "--paths", "apps/api/src/routes/webhooks.ts",
    "--acceptance", "handler patch reviewed"
  ]);
  assert.match(highConflict.text, /Conflicts: capsule-.*\(high_conflict\)/);

  assert.match((await callCli(["capsule", "update", capsuleId ?? "", "--status", "in_review", "--reviewer", "lead"])).text, /\[in_review\]/);
  const state = await json<{ capsules: { id: string; status: string; reviewer?: string; allowedPaths: string[] }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
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
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  const callCli = async (argv: string[]) => json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}` },
    body: JSON.stringify({ argv })
  }), bindings));

  const task = await callCli(["task", "create", "Merge queue task", "--assign", "dev"]);
  const taskId = task.text.match(/Task (task-[^ ]+) created/)?.[1];
  assert.equal(typeof taskId, "string");

  const capsule = await callCli([
    "capsule", "create",
    "--goal", "Merge queue capsule",
    "--owner", "dev",
    "--branch", "king/dev/merge-queue",
    "--paths", "src/merge.ts",
    "--task", taskId ?? ""
  ]);
  const capsuleId = capsule.text.match(/Capsule (capsule-[^ ]+) created/)?.[1];
  assert.equal(typeof capsuleId, "string");

  const queued = await callCli(["merge", "enqueue", "--capsule", capsuleId ?? "", "--target", "main"]);
  assert.match(queued.text, /merge queued merge-/);
  const mergeId = queued.text.match(/merge queued (merge-[^ ]+)/)?.[1];
  assert.equal(typeof mergeId, "string");
  assert.match((await callCli(["merge", "list"])).text, /\[queued\].*king\/dev\/merge-queue -> main by dev/);
  assert.match((await callCli(["merge", "enqueue", "--capsule", capsuleId ?? ""])).text, /already queued/);
  assert.match((await callCli(["merge", "get", mergeId ?? ""])).text, /"capsuleId": "capsule-/);
  assert.match((await callCli(["merge", "mark", mergeId ?? "", "testing"])).text, /marked testing/);
  assert.match((await callCli(["merge", "mark", mergeId ?? "", "merged"])).text, /marked merged/);

  const state = await json<{ mergeQueue: { id: string; status: string; branch: string }[]; capsules: { id: string; status: string }[]; tasks: { id: string; status: string; result?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.deepEqual(state.mergeQueue.map((row) => `${row.branch}:${row.status}`), ["king/dev/merge-queue:merged"]);
  assert.equal(state.capsules.find((row) => row.id === capsuleId)?.status, "merged");
  assert.equal(state.tasks.find((row) => row.id === taskId)?.status, "done");
  assert.match(state.tasks.find((row) => row.id === taskId)?.result ?? "", /merged via merge-/);

  assert.match((await callCli(["merge", "enqueue", "--branch", "bad branch"])).text, /invalid branch name/);
});

test("gui runtime records CTO-style review gates for capsules", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  const callCli = async (argv: string[]) => json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}` },
    body: JSON.stringify({ argv })
  }), bindings));

  const task = await callCli(["task", "create", "Review gate task", "--assign", "dev"]);
  const taskId = task.text.match(/Task (task-[^ ]+) created/)?.[1];
  assert.equal(typeof taskId, "string");
  const capsule = await callCli([
    "capsule", "create",
    "--goal", "Review gate capsule",
    "--owner", "dev",
    "--branch", "king/dev/review-gate",
    "--paths", "src/review.ts",
    "--acceptance", "review gate passes",
    "--task", taskId ?? "",
    "--reviewer", "cto"
  ]);
  const capsuleId = capsule.text.match(/Capsule (capsule-[^ ]+) created/)?.[1];
  assert.equal(typeof capsuleId, "string");
  const queued = await callCli(["merge", "enqueue", "--capsule", capsuleId ?? ""]);
  const mergeId = queued.text.match(/merge queued (merge-[^ ]+)/)?.[1];
  assert.equal(typeof mergeId, "string");

  const rejected = await callCli([
    "review", "record",
    "--capsule", capsuleId ?? "",
    "--merge", mergeId ?? "",
    "--coverage", "92",
    "--checks", "true",
    "--acceptance", "true",
    "--scope", "false",
    "--tests", "true",
    "--regressions", "true",
    "--comment", "scope drift"
  ]);
  assert.match(rejected.text, /decision=changes_requested/);
  assert.match(rejected.text, /coverage below 95%; scope mismatch/);
  const rejectedId = rejected.text.match(/review recorded (review-[^ ]+)/)?.[1];
  assert.equal(typeof rejectedId, "string");
  assert.match((await callCli(["review", "get", rejectedId ?? ""])).text, /"comment": "scope drift"/);
  assert.match((await callCli(["review", "list", "--decision", "changes_requested"])).text, /\[changes_requested\].*reviewer=cto.*coverage=92%/);

  const approved = await callCli([
    "review", "record",
    "--capsule", capsuleId ?? "",
    "--merge", mergeId ?? "",
    "--coverage", "96",
    "--checks", "true",
    "--acceptance", "true",
    "--scope", "true",
    "--tests", "true",
    "--regressions", "true"
  ]);
  assert.match(approved.text, /decision=approved/);

  const state = await json<{ mergeQueue: { id: string; status: string }[]; reviews: { decision: string; capsuleId: string }[]; capsules: { id: string; status: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.equal(state.mergeQueue.find((row) => row.id === mergeId)?.status, "testing");
  assert.equal(state.capsules.find((row) => row.id === capsuleId)?.status, "in_review");
  assert.deepEqual(state.reviews.map((row) => row.decision), ["changes_requested", "approved"]);
  assert.deepEqual(state.reviews.map((row) => row.capsuleId), [capsuleId, capsuleId]);
});

test("gui runtime supports structured artifact commands", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  const callCli = async (argv: string[]) => json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}` },
    body: JSON.stringify({ argv })
  }), bindings));

  const task = await callCli(["task", "create", "Collect evidence"]);
  const taskId = task.text.match(/Task (task-[^ ]+) created/)?.[1];
  assert.equal(typeof taskId, "string");

  const put = await callCli([
    "artifact",
    "put",
    "--kind", "tech_spec",
    "--path", "runtime/protocol/task-pool",
    "--source", "king-agent",
    "--confidence", "0.75",
    "--task", taskId ?? "",
    "--content", "spec content",
    "{\"name\":\"Task protocol\"}"
  ]);
  assert.match(put.text, /artifact stored artifact-/);
  const artifactId = put.text.match(/artifact stored (artifact-[^ ]+)/)?.[1];
  assert.equal(typeof artifactId, "string");
  assert.match((await callCli(["artifact", "check", artifactId ?? ""])).text, /artifact quality valid=false/);
  assert.match((await callCli(["artifact", "check", artifactId ?? ""])).text, /metadata should include collection date/);

  assert.match((await callCli(["artifact", "list", "--unverified"])).text, /\[unverified\].*tech_spec.*runtime\/protocol\/task-pool/);
  const artifact = await callCli(["artifact", "get", artifactId ?? ""]);
  assert.match(artifact.text, /"content": "spec content"/);
  assert.match(artifact.text, /"name": "Task protocol"/);
  assert.match(artifact.text, /"quality_warnings": \[/);
  assert.match(artifact.text, /"quality_score": 0.88/);

  const goodCheck = await callCli([
    "artifact", "check",
    "--kind", "budget_item",
    "--path", "costs/opex/rent",
    "--source", "estimate",
    "--confidence", "0.4",
    "{\"item\":\"rent\",\"amount\":350000,\"currency\":\"JPY\",\"collected_at\":\"2026-06-02\"}"
  ]);
  assert.match(goodCheck.text, /artifact quality valid=true score=1/);

  assert.match((await callCli([
    "artifact", "put",
    "--kind", "custom_kind",
    "--path", "custom/path",
    "--source", "king-agent",
    "--confidence", "0.9",
    "{\"name\":\"Custom\"}"
  ])).text, /non-standard artifact kind/);
  assert.match((await callCli([
    "artifact", "put",
    "--kind", "custom_kind",
    "--path", "custom/path",
    "--source", "king-agent",
    "--confidence", "0.9",
    "--allow-nonstandard",
    "{\"name\":\"Custom\"}"
  ])).text, /artifact stored .*warnings=/);
  assert.match((await callCli([
    "artifact", "check",
    "--kind", "budget_item",
    "--path", "costs",
    "--source", "training_data",
    "--confidence", "0.9",
    "{\"amount\":1}"
  ])).text, /path should use domain\/category\/item/);
  assert.match((await callCli([
    "artifact", "check",
    "--kind", "budget_item",
    "--path", "costs",
    "--source", "training_data",
    "--confidence", "0.9",
    "{\"amount\":1}"
  ])).text, /training_data confidence should be <= 0.3/);
});

test("gui runtime supports shared context commands", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  const callCli = async (argv: string[]) => json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}` },
    body: JSON.stringify({ argv })
  }), bindings));

  assert.match((await callCli(["context", "get", "decision"])).text, /not found/);
  assert.match((await callCli(["context", "set", "decision", "ship", "task", "pool", "--agent", "planner"])).text, /ship task pool/);
  assert.equal((await callCli(["context", "get", "decision"])).text, "ship task pool");
  assert.match((await callCli(["context", "list"])).text, /decision\tship task pool\tupdatedBy=planner/);
  assert.match((await callCli(["context", "set", "decision", "ship", "artifact", "store"])).text, /ship artifact store/);

  const state = await json<{ context: { key: string; value: string; updatedBy: string; updatedAt: number }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.equal(state.context[0]?.key, "decision");
  assert.equal(state.context[0]?.value, "ship artifact store");
  assert.equal(state.context[0]?.updatedBy, "king-agent");
  assert.equal(typeof state.context[0]?.updatedAt, "number");
  assert.match((await callCli(["context", "delete", "decision"])).text, /Deleted/);
  assert.match((await callCli(["context", "list"])).text, /No context entries/);
});

test("gui runtime supports hypothesis tracking with artifact evidence", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  const callCli = async (argv: string[]) => json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}` },
    body: JSON.stringify({ argv })
  }), bindings));

  const artifact = await callCli([
    "artifact", "put",
    "--kind", "market_data",
    "--path", "market/evidence/gui",
    "--source", "king-agent",
    "--confidence", "0.9",
    "{\"name\":\"Evidence\"}"
  ]);
  const artifactId = artifact.text.match(/artifact stored (artifact-[^ ]+)/)?.[1];
  assert.equal(typeof artifactId, "string");

  const created = await callCli([
    "hypothesis",
    "create",
    "Gui runtime needs hypothesis tracking",
    "--rationale", "Artifact evidence should support decisions",
    "--expected-value", "Better agent research loops",
    "--estimated-cost", "1 task"
  ]);
  assert.match(created.text, /Hypothesis hyp-/);
  const hypothesisId = created.text.match(/Hypothesis (hyp-[^ ]+) created/)?.[1];
  assert.equal(typeof hypothesisId, "string");

  assert.match((await callCli(["hypothesis", "list", "--status", "proposed"])).text, /\[proposed\].*Gui runtime needs hypothesis tracking/);
  assert.match((await callCli(["hypothesis", "update", hypothesisId ?? "", "--status", "validated", "--outcome", "Evidence linked", "--evidence", artifactId ?? ""])).text, /status=validated/);
  assert.match((await callCli(["hypothesis", "list", "--status", "validated"])).text, new RegExp(`evidence=${artifactId}`));

  const child = await callCli(["hypothesis", "create", "Child branch", "--parent", hypothesisId ?? ""]);
  const childId = child.text.match(/Hypothesis (hyp-[^ ]+) created/)?.[1];
  assert.equal(typeof childId, "string");
  assert.match((await callCli(["hypothesis", "list", "--tree", hypothesisId ?? ""])).text, /Child branch/);

  const state = await json<{ hypotheses: { id: string; status: string; evidenceArtifactIds?: string[] }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.equal(state.hypotheses.find((row) => row.id === hypothesisId)?.status, "validated");
  assert.deepEqual(state.hypotheses.find((row) => row.id === hypothesisId)?.evidenceArtifactIds, [artifactId]);
});

test("gui runtime applies execution plans into scoped tasks", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  const callCli = async (argv: string[]) => json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}` },
    body: JSON.stringify({ argv })
  }), bindings));

  const plan = JSON.stringify({
    optionId: "option-1",
    tasks: [
      {
        title: "Design task model",
        description: "Define scoped task fields",
        scope: { paths: ["src/tasks.ts"] },
        dependencies: [],
        estimatedTokens: 1200,
        priority: 12
      },
      {
        title: "Implement task model",
        description: "Wire task fields into runtime",
        scope: { paths: ["src/tasks.ts"], patterns: ["test/*.test.ts"] },
        dependencies: ["Design task model"],
        estimatedTokens: 2400,
        priority: 8
      }
    ]
  });

  assert.match((await callCli(["plan", "parse", `\`\`\`json\n${plan}\n\`\`\``])).text, /plan option-1: 2 task\(s\), estimatedTokens=3600/);
  const applied = await callCli(["plan", "apply", plan, "--assign", "planner", "--initiative", "initiative-1"]);
  assert.match(applied.text, /plan applied option-1: 2 task\(s\) created/);
  const createdIds = [...applied.text.matchAll(/- (task-[^ ]+) "/g)].map((match) => match[1]);
  assert.equal(createdIds.length, 2);
  assert.match(applied.text, new RegExp(`after=${createdIds[0]?.slice(0, 10)}`));

  const state = await json<{ tasks: { title: string; priority: number; assignee?: string; initiativeId?: string; dependsOn?: string[]; scope?: { paths?: string[]; patterns?: string[] }; executionProfile?: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.deepEqual(state.tasks.map((task) => task.title), ["Design task model", "Implement task model"]);
  assert.equal(state.tasks[0]?.priority, 10);
  assert.equal(state.tasks[1]?.assignee, "planner");
  assert.equal(state.tasks[1]?.initiativeId, "initiative-1");
  assert.deepEqual(state.tasks[1]?.dependsOn, [createdIds[0]]);
  assert.deepEqual(state.tasks[1]?.scope?.patterns, ["test/*.test.ts"]);
  assert.equal(state.tasks[1]?.executionProfile, "plan:option-1");
  assert.match((await callCli(["plan", "parse", "{\"tasks\":[]}"])).text, /tasks array is empty/);
});

test("gui runtime records structured option evaluations", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  const callCli = async (argv: string[]) => json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}` },
    body: JSON.stringify({ argv })
  }), bindings));

  const evaluation = JSON.stringify({
    scores: [
      {
        optionId: "option-a",
        scores: { feasibility: 8, risk: 7, impact: 9, cost: 6 },
        reasoning: "higher impact"
      },
      {
        optionId: "option-b",
        scores: { feasibility: 9, risk: 9, impact: 5, cost: 8 },
        reasoning: "safer path"
      }
    ],
    confidence: 0.65,
    tokensUsed: 1234
  });

  const parsed = await callCli(["eval", "parse", `\`\`\`json\n${evaluation}\n\`\`\``]);
  assert.match(parsed.text, /evaluation selected=option-b confidence=0.65 requiresApproval=true tokens=1234/);
  assert.match(parsed.text, /option-a total=7.60/);
  assert.match(parsed.text, /option-b total=7.80/);

  const recorded = await callCli(["eval", "record", evaluation, "--artifact", "artifact-1", "--initiative", "initiative-1"]);
  assert.match(recorded.text, /evaluation recorded eval-.*selected=option-b requiresApproval=true/);
  const evaluationId = recorded.text.match(/evaluation recorded (eval-[^ ]+)/)?.[1];
  assert.equal(typeof evaluationId, "string");
  assert.match((await callCli(["eval", "list", "--approval-required"])).text, /\[approval_required\].*selected=option-b.*artifact=artifact-1/);

  const detail = await callCli(["evaluate", "get", evaluationId ?? ""]);
  assert.match(detail.text, /"selectedOptionId": "option-b"/);
  assert.match(detail.text, /"requiresHumanApproval": true/);
  assert.match(detail.text, /"totalScore": 7.8/);
  assert.match((await callCli(["eval", "parse", "{\"scores\":[]}"])).text, /scores array is empty/);
});

test("gui runtime tracks run feedback metrics by agent", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  const callCli = async (argv: string[]) => json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}` },
    body: JSON.stringify({ argv })
  }), bindings));

  const first = await callCli([
    "feedback", "record",
    "--run", "run-1",
    "--agent", "dev",
    "--task", "task-1",
    "--profile", "plan:option-a",
    "--completed", "true",
    "--tokens", "1000",
    "--duration-ms", "2000",
    "--steer-count", "1",
    "--quality", "0.9",
    "--accepted-by-user", "true",
    "--artifact-reused", "true"
  ]);
  assert.match(first.text, /feedback recorded feedback-.*agent=dev completed=true errored=false/);
  const firstId = first.text.match(/feedback recorded (feedback-[^ ]+)/)?.[1];
  assert.equal(typeof firstId, "string");

  assert.match((await callCli([
    "feedback", "record",
    "--run", "run-2",
    "--agent", "dev",
    "--completed", "false",
    "--errored", "true",
    "--human-intervention", "true",
    "--tokens", "500",
    "--duration-ms", "3000",
    "--revision-count", "2"
  ])).text, /completed=false errored=true/);
  assert.match((await callCli([
    "feedback", "record",
    "--run", "run-3",
    "--agent", "feedback",
    "--completed", "true",
    "--tokens", "700",
    "--duration-ms", "1000"
  ])).text, /agent=feedback completed=true/);

  assert.match((await callCli(["feedback", "list", "--agent", "dev", "--errored", "true"])).text, /\[error\].*agent=dev.*revisions=2/);
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
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  const callCli = async (argv: string[]) => json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}` },
    body: JSON.stringify({ argv })
  }), bindings));

  assert.match((await callCli(["safety", "check", "git_commit"])).text, /allowed: git_commit/);
  assert.match((await callCli(["safety", "check", "deploy_production"])).text, /approval required: deploy_production/);

  const requested = await callCli(["safety", "request", "deploy_production", "--reason", "ship release", "--context", "{\"ticket\":\"REL-1\"}"]);
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

  const state = await json<{ approvals: { action: string; status: string }[] }>(
    await worker.fetch(new Request("https://gui/gui/state"), bindings)
  );
  assert.deepEqual(state.approvals.map((approval) => `${approval.action}:${approval.status}`), [
    "deploy_production:approved",
    "delete_data:denied"
  ]);
});

test("gui runtime detects path conflicts for cards and claims", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  const callCli = async (argv: string[]) => json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenRes.token}` },
    body: JSON.stringify({ argv })
  }), bindings));

  assert.match((await callCli(["claim", "backend-work", "--paths", "src/api,src/service", "--owner", "agent-a"])).text, /claim created/);
  assert.match((await callCli(["claim", "api-work", "--paths", "src/api/routes"])).text, /path conflict: claim .* already covers src\/api/);
  assert.match((await callCli(["claim", "docs-work", "--paths", "README.md"])).text, /claim created/);
  assert.match((await callCli(["task", "create", "Own billing", "--assign", "agent-c", "--path", "src/billing"])).text, /Task task-/);
  assert.match((await callCli(["claim", "billing-work", "--paths", "src/billing/invoices", "--owner", "agent-d"])).text, /path conflict: task .* already covers src\/billing/);

  assert.match((await callCli(["card", "create", "Touch API", "--paths", "src/api"])).text, /card created/);
  const state = await json<{ cards: { id: string; allowedPaths?: string[] }[] }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const cardId = state.cards.at(-1)?.id;
  if (!cardId) assert.fail("expected created card id");
  assert.deepEqual(state.cards.at(-1)?.allowedPaths, ["src/api"]);
  assert.match((await callCli(["card", "claim", cardId, "--owner", "agent-b"])).text, /path conflict: claim .* already covers src\/api/);
  assert.match((await callCli(["capsule", "create", "--goal", "Own docs", "--paths", "docs/runtime", "--owner", "agent-a"])).text, /Capsule capsule-/);
  assert.match((await callCli(["task", "create", "Touch docs runtime", "--assign", "agent-b", "--path", "docs/runtime/api"])).text, /Warnings: capsule .* overlaps docs\/runtime/);
});

test("gui runtime supports quotes, reactions, docs, dms, and composing-aware glance", async () => {
  const bindings = env();
  const paired = await pairComputer(bindings, { engines: ["claude", "codex"] });
  const tokenRes = await json<{ token: string }>(
    await worker.fetch(new Request("https://gui/api/agents/king-agent/runtime-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.deviceToken}` }
    }), bindings)
  );
  const auth = { Authorization: `Bearer ${tokenRes.token}`, "Content-Type": "application/json" };
  await worker.fetch(new Request("https://gui/gui/message", {
    method: "POST",
    body: JSON.stringify({ body: "quote me" })
  }), bindings);
  const firstState = await json<{ messages: { id: string }[] }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const messageId = firstState.messages[0]?.id;
  assert.equal(typeof messageId, "string");

  const callCli = async (argv: string[]) => json<{ text: string }>(await worker.fetch(new Request("https://gui/runtime/cli", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ argv })
  }), bindings));

  assert.match((await callCli(["reply", "king-convo", "--quote", messageId, "quoted reply"])).text, /reply posted/);
  assert.match((await callCli(["reply", "king-convo", "line 1\nline 2 with `code` and $var"])).text, /reply posted/);
  assert.match((await callCli(["react", messageId, "(ok)"])).text, /reaction posted/);
  assert.match((await callCli(["dm", "king-agent", "hello teammate"])).text, /dm posted/);
  assert.match((await callCli(["doc", "create", "Plan", "Ship the gui"])).text, /doc created/);
  assert.match((await callCli(["doc", "list"])).text, /Plan/);
  const docState = await json<{ docs: { id: string }[] }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  const docId = docState.docs[0]?.id;
  assert.equal(typeof docId, "string");
  assert.match((await callCli(["doc", "append", docId, "Next step"])).text, /doc appended/);
  assert.match((await callCli(["doc", "show", docId])).text, /Next step/);
  assert.match((await callCli(["doc", "update", docId, "Final body"])).text, /doc updated/);
  assert.match((await callCli(["doc", "show", docId])).text, /Final body/);
  assert.match((await callCli(["claim", "shared-work", "--in", "king-convo"])).text, /claim created/);
  await worker.fetch(new Request("https://gui/runtime/thinking/mark", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ conversationIds: ["king-convo"] })
  }), bindings);
  const glance = await callCli(["glance", "king-convo"]);
  assert.match(glance.text, /Claim: shared-work by king-agent/);
  assert.match(glance.text, /Composing: King Agent/);
  await worker.fetch(new Request("https://gui/runtime/thinking/unmark", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ conversationIds: ["king-convo"] })
  }), bindings);
  const quietGlance = await callCli(["glance", "king-convo"]);
  assert.doesNotMatch(quietGlance.text, /Composing: King Agent/);

  const finalState = await json<{
    messages: { quoted_message_id?: string; body: string }[];
    reactions: { messageId: string; emoji: string }[];
    docs: { title: string }[];
  }>(await worker.fetch(new Request("https://gui/gui/state"), bindings));
  assert.equal(finalState.messages.some((msg) => msg.quoted_message_id === messageId), true);
  assert.equal(finalState.messages.some((msg) => msg.body === "line 1\nline 2 with `code` and $var"), true);
  assert.deepEqual(finalState.reactions.map((row) => [row.messageId, row.emoji]), [[messageId, "(ok)"]]);
  assert.deepEqual(finalState.docs.map((doc) => doc.title), ["Plan"]);
});
