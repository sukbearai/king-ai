import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { fetchHostWorkflowSnapshot, resolveHostDecision, runHostRemoteCommand } from "./host-bridge.js";
import { json } from "./gui-http.js";
import { renderPage } from "./page.js";
import { guiPageStyles } from "./gui-page-styles.js";
import type { GuiKanbanCardLike, GuiTaskLike } from "./workflow-state.js";

export type GuiBindings = {
  GUI_STATE: DurableObjectNamespace;
  AUTH_DB?: D1Database;
  BETTER_AUTH_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  BETTER_AUTH_URL?: string;
  KING_AI_TEST_AUTH_USER?: string;
  KING_AI_HOST_URL?: string;
  KING_AI_HOST_OUTPUT_DIR?: string;
};

type GuiEnv = { Bindings: GuiBindings };
type RouteContext = Context<GuiEnv>;

export type GuiRouteDeps = {
  requireGuiAuth: (c: RouteContext) => Promise<Response | null>;
  requireOwnerGuiAuth: (c: RouteContext) => Promise<Response | null>;
  stateForRequest: (c: RouteContext) => Promise<DurableObjectStub>;
  stateForTenant: (c: RouteContext, tenantId: string) => Promise<DurableObjectStub>;
  forwardHeaders: (c: RouteContext, headers?: Record<string, string>) => Promise<Headers>;
  authForRequest: (request: Request, env: GuiBindings) => { handler: (request: Request) => Response | Promise<Response> } | null;
  splitPairCode: (value: unknown) => { tenantId?: string; code?: string };
  sanitizeTenantId: (value: string) => string;
  tenantFromRequest: (c: RouteContext) => Promise<string>;
};

export function createGuiApp(deps: GuiRouteDeps): Hono<GuiEnv> {
  const app = new Hono<GuiEnv>();
  app.use("*", cors());

  app.on(["GET", "POST"], "/api/auth/*", (c) => {
    const auth = deps.authForRequest(c.req.raw, c.env);
    if (!auth) return json({ error: "auth_not_configured" }, { status: 404 });
    return auth.handler(c.req.raw);
  });

  app.get("/", async (c) => {
    const blocked = await deps.requireGuiAuth(c);
    if (blocked) return blocked;
    return c.html(renderPage(guiPageStyles));
  });
  app.get("/favicon.ico", () => new Response(null, { status: 204 }));

  app.post("/api/computers/pair", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const pairCode = deps.splitPairCode((body as { code?: unknown }).code);
    const tenantId = c.req.header("X-King-AI-Tenant") || pairCode.tenantId || await deps.tenantFromRequest(c);
    const stub = c.env.GUI_STATE.get(c.env.GUI_STATE.idFromName(deps.sanitizeTenantId(tenantId)));
    const headers = await deps.forwardHeaders(c);
    headers.set("X-King-AI-Tenant", deps.sanitizeTenantId(tenantId));
    return stub.fetch("https://state/pair", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, code: pairCode.code ?? (body as { code?: unknown }).code })
    });
  });

  app.get("/api/computers/me/agents", async (c) => {
    const stub = await deps.stateForRequest(c);
    return stub.fetch("https://state/agents", { headers: await deps.forwardHeaders(c) });
  });

  app.post("/api/computers/heartbeat", async (c) => await (await deps.stateForRequest(c)).fetch("https://state/heartbeat", {
    method: "POST",
    headers: await deps.forwardHeaders(c),
    body: JSON.stringify(await c.req.json().catch(() => ({})))
  }));

  app.post("/api/agents/:agentId/runtime-token", async (c) => {
    const stub = await deps.stateForRequest(c);
    return stub.fetch(`https://state/runtime-token/${c.req.param("agentId")}`, {
      method: "POST",
      headers: await deps.forwardHeaders(c)
    });
  });

  app.get("/runtime/wake-stream", async (c) => await (await deps.stateForRequest(c)).fetch("https://state/wake-stream", {
    headers: await deps.forwardHeaders(c)
  }));

  app.get("/runtime/inbox", async (c) => await (await deps.stateForRequest(c)).fetch("https://state/inbox", {
    headers: await deps.forwardHeaders(c)
  }));

  app.get("/runtime/inbox-triage/payload", async (c) => await (await deps.stateForRequest(c)).fetch("https://state/triage", {
    headers: await deps.forwardHeaders(c)
  }));

  app.get("/runtime/agenda", async (c) => await (await deps.stateForRequest(c)).fetch("https://state/agenda", {
    headers: await deps.forwardHeaders(c)
  }));

  app.get("/runtime/roster", async (c) => await (await deps.stateForRequest(c)).fetch("https://state/roster", {
    headers: await deps.forwardHeaders(c)
  }));

  app.get("/runtime/preamble", async (c) => await (await deps.stateForRequest(c)).fetch(`https://state/preamble?${new URL(c.req.url).searchParams.toString()}`, {
    headers: await deps.forwardHeaders(c)
  }));

  app.post("/runtime/cli", async (c) => await (await deps.stateForRequest(c)).fetch("https://state/cli", {
    method: "POST",
    headers: await deps.forwardHeaders(c, { "Content-Type": "application/json" }),
    body: JSON.stringify(await c.req.json())
  }));

  app.post("/runtime/status", async (c) => await (await deps.stateForRequest(c)).fetch("https://state/status", {
    method: "POST",
    headers: await deps.forwardHeaders(c, { "Content-Type": "application/json" }),
    body: JSON.stringify(await c.req.json().catch(() => ({})))
  }));
  app.post("/runtime/typing", async (c) => await (await deps.stateForRequest(c)).fetch("https://state/typing", {
    method: "POST",
    headers: await deps.forwardHeaders(c, { "Content-Type": "application/json" }),
    body: JSON.stringify(await c.req.json().catch(() => ({})))
  }));
  app.post("/runtime/thinking/mark", async (c) => await (await deps.stateForRequest(c)).fetch("https://state/thinking/mark", {
    method: "POST",
    headers: await deps.forwardHeaders(c, { "Content-Type": "application/json" }),
    body: JSON.stringify(await c.req.json().catch(() => ({})))
  }));
  app.post("/runtime/thinking/unmark", async (c) => await (await deps.stateForRequest(c)).fetch("https://state/thinking/unmark", {
    method: "POST",
    headers: await deps.forwardHeaders(c, { "Content-Type": "application/json" }),
    body: JSON.stringify(await c.req.json().catch(() => ({})))
  }));
  app.post("/runtime/events", async (c) => await (await deps.stateForRequest(c)).fetch("https://state/events", {
    method: "POST",
    headers: await deps.forwardHeaders(c, { "Content-Type": "application/json" }),
    body: JSON.stringify(await c.req.json().catch(() => ({})))
  }));
  app.post("/runtime/notices", async (c) => await (await deps.stateForRequest(c)).fetch("https://state/notices", {
    method: "POST",
    headers: await deps.forwardHeaders(c, { "Content-Type": "application/json" }),
    body: JSON.stringify(await c.req.json().catch(() => ({})))
  }));
  app.post("/runtime/triage", async (c) => await (await deps.stateForRequest(c)).fetch("https://state/triage-log", {
    method: "POST",
    headers: await deps.forwardHeaders(c, { "Content-Type": "application/json" }),
    body: JSON.stringify(await c.req.json().catch(() => ({})))
  }));
  app.post("/runtime/runs", async (c) => await (await deps.stateForRequest(c)).fetch("https://state/runs", {
    method: "POST",
    headers: await deps.forwardHeaders(c, { "Content-Type": "application/json" }),
    body: JSON.stringify(await c.req.json().catch(() => ({})))
  }));
  app.post("/runtime/runs/:runId/heartbeat", async (c) => await (await deps.stateForRequest(c)).fetch(`https://state/runs/${c.req.param("runId")}/heartbeat`, {
    method: "POST",
    headers: await deps.forwardHeaders(c, { "Content-Type": "application/json" }),
    body: JSON.stringify(await c.req.json().catch(() => ({})))
  }));
  app.post("/runtime/runs/:runId/finish", async (c) => await (await deps.stateForRequest(c)).fetch(`https://state/runs/${c.req.param("runId")}/finish`, {
    method: "POST",
    headers: await deps.forwardHeaders(c, { "Content-Type": "application/json" }),
    body: JSON.stringify(await c.req.json().catch(() => ({})))
  }));
  app.get("/runtime/runs/:runId/actions", async (c) => await (await deps.stateForRequest(c)).fetch(`https://state/runs/${c.req.param("runId")}/actions`, {
    headers: await deps.forwardHeaders(c)
  }));
  app.post("/runtime/conversation/mark-read", async (c) => await (await deps.stateForRequest(c)).fetch("https://state/mark-read", {
    method: "POST",
    headers: await deps.forwardHeaders(c, { "Content-Type": "application/json" }),
    body: JSON.stringify(await c.req.json())
  }));

  app.get("/gui/state", async (c) => {
    const blocked = await deps.requireGuiAuth(c);
    if (blocked) return blocked;
    const isRemoteAssist = Boolean(new URL(c.req.url).searchParams.get("assist") || c.req.header("X-King-AI-Assist-Token"));
    return (await deps.stateForRequest(c)).fetch(`https://state/gui-state${isRemoteAssist ? "?redact=1" : ""}`);
  });
  app.get("/gui/summary", async (c) => {
    const blocked = await deps.requireGuiAuth(c);
    if (blocked) return blocked;
    const search = new URL(c.req.url).search;
    return (await deps.stateForRequest(c)).fetch(`https://state/gui-summary${search}`, { headers: await deps.forwardHeaders(c) });
  });
  app.get("/gui/activity", async (c) => {
    const blocked = await deps.requireGuiAuth(c);
    if (blocked) return blocked;
    return (await deps.stateForRequest(c)).fetch(`https://state/gui-activity?${new URL(c.req.url).searchParams.toString()}`);
  });
  app.get("/gui/storage-debug", async (c) => {
    const blocked = await deps.requireOwnerGuiAuth(c);
    if (blocked) return blocked;
    return (await deps.stateForRequest(c)).fetch("https://state/gui-storage-debug");
  });
  app.get("/gui/export-state", async (c) => {
    const blocked = await deps.requireOwnerGuiAuth(c);
    if (blocked) return blocked;
    return (await deps.stateForRequest(c)).fetch("https://state/gui-export-state");
  });
  app.post("/gui/import-state", async (c) => {
    const blocked = await deps.requireOwnerGuiAuth(c);
    if (blocked) return blocked;
    return (await deps.stateForRequest(c)).fetch("https://state/gui-import-state", {
      method: "POST",
      body: JSON.stringify(await c.req.json().catch(() => null))
    });
  });
  app.post("/gui/reset-state", async (c) => {
    const blocked = await deps.requireOwnerGuiAuth(c);
    if (blocked) return blocked;
    return (await deps.stateForRequest(c)).fetch("https://state/gui-reset-state", { method: "POST" });
  });
  app.post("/gui/message", async (c) => {
    const blocked = await deps.requireGuiAuth(c);
    if (blocked) return blocked;
    return (await deps.stateForRequest(c)).fetch("https://state/gui-message", {
      method: "POST",
      headers: await deps.forwardHeaders(c, { "Content-Type": "application/json" }),
      body: JSON.stringify(await c.req.json().catch(() => ({})))
    });
  });
  app.post("/gui/attachments", async (c) => {
    const blocked = await deps.requireGuiAuth(c);
    if (blocked) return blocked;
    return (await deps.stateForRequest(c)).fetch("https://state/gui-attachments", {
      method: "POST",
      headers: await deps.forwardHeaders(c, { "Content-Type": "application/json" }),
      body: JSON.stringify(await c.req.json().catch(() => ({})))
    });
  });
  app.get("/gui/attachments/:attachmentId", async (c) => {
    const url = new URL(c.req.url);
    const tenantId = url.searchParams.get("tenant") || c.req.header("X-King-AI-Tenant") || "global";
    return (await deps.stateForTenant(c, tenantId)).fetch(`https://state/gui-attachments/${encodeURIComponent(c.req.param("attachmentId"))}?${url.searchParams.toString()}`);
  });
  app.post("/gui/conversations", async (c) => {
    const blocked = await deps.requireGuiAuth(c);
    if (blocked) return blocked;
    return (await deps.stateForRequest(c)).fetch("https://state/gui-conversations", {
      method: "POST",
      body: JSON.stringify(await c.req.json().catch(() => ({})))
    });
  });
  app.post("/gui/conversations/:conversationId/team", async (c) => {
    const blocked = await deps.requireGuiAuth(c);
    if (blocked) return blocked;
    return (await deps.stateForRequest(c)).fetch(`https://state/gui-conversations/${c.req.param("conversationId")}/team`, {
      method: "POST",
      body: JSON.stringify(await c.req.json().catch(() => ({})))
    });
  });
  app.post("/gui/workflows/:workflowId/agents", async (c) => {
    const blocked = await deps.requireOwnerGuiAuth(c);
    if (blocked) return blocked;
    return (await deps.stateForRequest(c)).fetch(`https://state/gui-workflows/${c.req.param("workflowId")}/agents`, {
      method: "POST",
      body: JSON.stringify(await c.req.json().catch(() => ({})))
    });
  });
  app.post("/gui/conversations/:conversationId/delete", async (c) => {
    const blocked = await deps.requireGuiAuth(c);
    if (blocked) return blocked;
    return (await deps.stateForRequest(c)).fetch(`https://state/gui-conversations/${c.req.param("conversationId")}/delete`, { method: "POST" });
  });
  app.post("/gui/clear-messages", async (c) => {
    const blocked = await deps.requireGuiAuth(c);
    if (blocked) return blocked;
    return (await deps.stateForRequest(c)).fetch("https://state/gui-clear-messages", {
      method: "POST",
      body: JSON.stringify(await c.req.json().catch(() => ({})))
    });
  });
  app.post("/gui/agent-config", async (c) => {
    const blocked = await deps.requireOwnerGuiAuth(c);
    if (blocked) return blocked;
    return (await deps.stateForRequest(c)).fetch("https://state/gui-agent-config", {
      method: "POST",
      body: JSON.stringify(await c.req.json().catch(() => ({})))
    });
  });
  app.post("/gui/card", async (c) => {
    const blocked = await deps.requireGuiAuth(c);
    if (blocked) return blocked;
    return (await deps.stateForRequest(c)).fetch("https://state/gui-card", {
      method: "POST",
      body: JSON.stringify(await c.req.json().catch(() => ({})))
    });
  });
  app.post("/gui/task", async (c) => {
    const blocked = await deps.requireGuiAuth(c);
    if (blocked) return blocked;
    return (await deps.stateForRequest(c)).fetch("https://state/gui-task", {
      method: "POST",
      body: JSON.stringify(await c.req.json().catch(() => ({})))
    });
  });
  app.post("/gui/task/:taskId/update", async (c) => {
    const blocked = await deps.requireGuiAuth(c);
    if (blocked) return blocked;
    return (await deps.stateForRequest(c)).fetch(`https://state/gui-task/${c.req.param("taskId")}/update`, {
      method: "POST",
      body: JSON.stringify(await c.req.json().catch(() => ({})))
    });
  });
  app.post("/gui/card/:cardId/move", async (c) => {
    const blocked = await deps.requireGuiAuth(c);
    if (blocked) return blocked;
    return (await deps.stateForRequest(c)).fetch(`https://state/gui-card/${c.req.param("cardId")}/move`, {
      method: "POST",
      body: JSON.stringify(await c.req.json().catch(() => ({})))
    });
  });
  app.post("/gui/conversation/mark-read", async (c) => {
    const blocked = await deps.requireGuiAuth(c);
    if (blocked) return blocked;
    return (await deps.stateForRequest(c)).fetch("https://state/gui-conversation/mark-read", {
      method: "POST",
      body: JSON.stringify(await c.req.json().catch(() => ({})))
    });
  });
  app.post("/gui/wake", async (c) => {
    const blocked = await deps.requireGuiAuth(c);
    if (blocked) return blocked;
    return (await deps.stateForRequest(c)).fetch("https://state/gui-wake", {
      method: "POST",
      body: JSON.stringify(await c.req.json().catch(() => ({})))
    });
  });
  app.post("/gui/remote-assist/share", async (c) => {
    const blocked = await deps.requireOwnerGuiAuth(c);
    if (blocked) return blocked;
    return (await deps.stateForRequest(c)).fetch("https://state/gui-remote-assist/share", {
      method: "POST",
      headers: await deps.forwardHeaders(c, { "Content-Type": "application/json" }),
      body: JSON.stringify(await c.req.json().catch(() => ({})))
    });
  });
  app.post("/gui/remote-assist/revoke", async (c) => {
    const blocked = await deps.requireOwnerGuiAuth(c);
    if (blocked) return blocked;
    return (await deps.stateForRequest(c)).fetch("https://state/gui-remote-assist/revoke", {
      method: "POST",
      body: JSON.stringify(await c.req.json().catch(() => ({})))
    });
  });
  app.post("/gui/approvals/:id/resolve", async (c) => {
    const blocked = await deps.requireGuiAuth(c);
    if (blocked) return blocked;
    return (await deps.stateForRequest(c)).fetch(`https://state/gui-approval/${encodeURIComponent(c.req.param("id"))}/resolve`, {
      method: "POST",
      body: JSON.stringify(await c.req.json().catch(() => ({})))
    });
  });
  app.get("/gui/host-decisions", async (c) => {
    const blocked = await deps.requireGuiAuth(c);
    if (blocked) return blocked;
    const stateRes = await (await deps.stateForRequest(c)).fetch("https://state/gui-state");
    const state = await stateRes.json() as { tasks: GuiTaskLike[]; cards: GuiKanbanCardLike[] };
    const snapshot = await fetchHostWorkflowSnapshot(c.env, c.req.raw, {
      tasks: state.tasks,
      kanban: state.cards
    });
    return json({
      configured: snapshot.configured,
      cards: snapshot.hostCards,
      workflowCards: snapshot.workflowCards,
      error: snapshot.error
    });
  });
  app.post("/gui/host-decisions/:id/resolve", async (c) => {
    const blocked = await deps.requireGuiAuth(c);
    if (blocked) return blocked;
    const body = await c.req.json().catch(() => ({})) as { decision?: string };
    const decision = body.decision === "approve" || body.decision === "approved"
      ? "approve"
      : body.decision === "deny" || body.decision === "denied"
        ? "deny"
        : undefined;
    if (!decision) return json({ ok: false, error: "decision must be approve or deny" }, { status: 400 });
    const result = await resolveHostDecision(c.env, c.req.raw, c.req.param("id"), decision);
    return json(result, { status: result.ok ? 200 : result.error === "host bridge not configured" ? 404 : 400 });
  });
  app.get("/gui/remote-config", async (c) => {
    const blocked = await deps.requireOwnerGuiAuth(c);
    if (blocked) return blocked;
    const result = await runHostRemoteCommand(c.env, c.req.raw, "remote-config-get", { revealSecrets: true });
    return json(result, { status: result.configured ? 200 : 404 });
  });
  app.put("/gui/remote-config", async (c) => {
    const blocked = await deps.requireOwnerGuiAuth(c);
    if (blocked) return blocked;
    const payload = await c.req.json().catch(() => ({}));
    const result = await runHostRemoteCommand(c.env, c.req.raw, "remote-config-save", payload);
    return json(result, { status: result.configured && result.result?.ok !== false ? 200 : result.configured ? 400 : 404 });
  });
  app.get("/gui/remote-devices", async (c) => {
    const blocked = await deps.requireGuiAuth(c);
    if (blocked) return blocked;
    const result = await runHostRemoteCommand(c.env, c.req.raw, "remote-list");
    return json(result, { status: result.configured ? 200 : 404 });
  });
  app.post("/gui/remote-devices", async (c) => {
    const blocked = await deps.requireOwnerGuiAuth(c);
    if (blocked) return blocked;
    const payload = await c.req.json().catch(() => ({}));
    const result = await runHostRemoteCommand(c.env, c.req.raw, "remote-save-device", payload);
    return json(result, { status: result.configured && result.result?.ok !== false ? 200 : result.configured ? 400 : 404 });
  });
  app.delete("/gui/remote-devices/:id", async (c) => {
    const blocked = await deps.requireOwnerGuiAuth(c);
    if (blocked) return blocked;
    const result = await runHostRemoteCommand(c.env, c.req.raw, "remote-delete-device", { id: c.req.param("id") });
    return json(result, { status: result.configured && result.result?.ok !== false ? 200 : result.configured ? 400 : 404 });
  });
  app.post("/gui/remote-devices/:id/probe", async (c) => {
    const blocked = await deps.requireGuiAuth(c);
    if (blocked) return blocked;
    const result = await runHostRemoteCommand(c.env, c.req.raw, "remote-probe", { device: c.req.param("id") });
    return json(result, { status: result.configured ? 200 : 404 });
  });
  app.post("/gui/remote-devices/:id/profile", async (c) => {
    const blocked = await deps.requireGuiAuth(c);
    if (blocked) return blocked;
    const result = await runHostRemoteCommand(c.env, c.req.raw, "remote-profile", { device: c.req.param("id") });
    return json(result, { status: result.configured ? 200 : 404 });
  });

  return app;
}
