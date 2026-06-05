import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHostCommand } from "../src/host-control.js";
import { listHostRunRequests } from "../src/host-runs.js";
import {
  createHostStatusServer,
  DEFAULT_HOST_SERVER_PORT,
  hostServerPortFromEnv,
  normalizeHostServerHost,
  startHostStatusServer
} from "../src/host-server.js";

const EXPECTED_HOST_COMMANDS = ["status", "usage", "expenses", "events", "timeline", "policy", "doctor", "plan-run", "preflight", "prepare-run-layout", "submit-run", "run-requests", "run-request", "update-run", "cancel-run", "execute-run", "task-create", "task-list", "task-update", "agenda", "capsule-create", "capsule-list", "capsule-update", "workflow-create", "workflow-list", "workflow-update", "initiative-create", "handoff-create", "review-create", "decision-create", "artifact-create", "feedback-record", "feedback-list", "feedback-summary", "cron-check", "emit-run-event", "watch-run", "run-results", "run-heartbeat", "run-meta", "plan-export", "export", "compact-ledger", "remote-config-get", "remote-config-save", "remote-list", "remote-save-device", "remote-delete-device", "remote-default-device", "remote-probe", "remote-profile", "remote-run", "remote-logs", "remote-find-logs", "remote-pg", "remote-redis"];

test("host server config only allows localhost bindings", () => {
  assert.equal(normalizeHostServerHost(), "127.0.0.1");
  assert.equal(normalizeHostServerHost("localhost"), "localhost");
  assert.equal(normalizeHostServerHost("::1"), "::1");
  assert.throws(() => normalizeHostServerHost("0.0.0.0"), /localhost bindings/);
});

test("host server exposes remote test device configuration endpoints", async (t) => {
  let devices: Array<{ id?: string; password?: string; auth?: string }> = [];
  const server = await startHostStatusServer({
    port: 0,
    runCommand: async (request) => {
      if (request.command === "remote-config-save") {
        const input = request.input as { devices?: Array<{ id?: string; password?: string }> };
        devices = (input.devices ?? []).map((device) => ({
          id: device.id,
          auth: device.password ? "password" : "ssh-agent"
        }));
        return { ok: true, command: request.command, exitCode: 0, text: "config saved", json: { config: input, devices } };
      }
      if (request.command === "remote-config-get") {
        return { ok: true, command: request.command, exitCode: 0, text: "config", json: { config: { defaultDevice: devices[0]?.id, devices }, devices } };
      }
      if (request.command === "remote-save-device") {
        const input = request.input as { id?: string; password?: string };
        devices = [{ id: input.id, auth: input.password ? "password" : "ssh-agent" }];
        return { ok: true, command: request.command, exitCode: 0, text: "saved", json: { device: devices[0], devices } };
      }
      if (request.command === "remote-list") {
        return { ok: true, command: request.command, exitCode: 0, text: "list", json: { devices } };
      }
      if (request.command === "remote-delete-device") {
        devices = [];
        return { ok: true, command: request.command, exitCode: 0, text: "deleted", json: { devices } };
      }
      return { ok: false, command: request.command, exitCode: 64, text: "unsupported", error: "unsupported" };
    }
  });
  t.after(async () => {
    server.close();
    await once(server, "close").catch(() => undefined);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const configSaved = await fetch(`${baseUrl}/remote/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      defaultDevice: "test-61",
      devices: [
        { id: "test-61", host: "10.12.9.61", user: "root", password: "secret" },
        { id: "test-62", host: "10.12.9.62", user: "root" }
      ]
    })
  }).then((res) => res.json()) as { ok?: boolean; command?: string; json?: { devices?: Array<{ id?: string; password?: string; auth?: string }> } };
  assert.equal(configSaved.ok, true);
  assert.equal(configSaved.command, "remote-config-save");
  assert.deepEqual(configSaved.json?.devices?.map((device) => device.id), ["test-61", "test-62"]);
  assert.equal(configSaved.json?.devices?.[0]?.password, undefined);
  assert.equal(configSaved.json?.devices?.[0]?.auth, "password");

  const configLoaded = await fetch(`${baseUrl}/remote/config`).then((res) => res.json()) as { ok?: boolean; command?: string; json?: { config?: { devices?: Array<{ id?: string }> } } };
  assert.equal(configLoaded.ok, true);
  assert.equal(configLoaded.command, "remote-config-get");
  assert.deepEqual(configLoaded.json?.config?.devices?.map((device) => device.id), ["test-61", "test-62"]);

  const saved = await fetch(`${baseUrl}/remote/devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "test-61",
      host: "10.12.9.61",
      user: "root",
      password: "secret",
      defaultApp: "fc",
      apps: { fc: { logRoots: ["/gpfc/logs"] } }
    })
  }).then((res) => res.json()) as { ok?: boolean; command?: string; json?: { device?: { id?: string; password?: string; auth?: string } } };
  assert.equal(saved.ok, true);
  assert.equal(saved.command, "remote-save-device");
  assert.equal(saved.json?.device?.id, "test-61");
  assert.equal(saved.json?.device?.password, undefined);
  assert.equal(saved.json?.device?.auth, "password");

  const listed = await fetch(`${baseUrl}/remote/devices`).then((res) => res.json()) as { ok?: boolean; json?: { devices?: Array<{ id?: string; password?: string }> } };
  assert.equal(listed.ok, true);
  assert.equal(listed.json?.devices?.[0]?.id, "test-61");
  assert.equal(listed.json?.devices?.[0]?.password, undefined);

  const removed = await fetch(`${baseUrl}/remote/devices/test-61`, { method: "DELETE" }).then((res) => res.json()) as { ok?: boolean; command?: string; json?: { devices?: unknown[] } };
  assert.equal(removed.ok, true);
  assert.equal(removed.command, "remote-delete-device");
  assert.equal(removed.json?.devices?.length, 0);
});

test("host server port can be read from env", () => {
  assert.equal(hostServerPortFromEnv({}), DEFAULT_HOST_SERVER_PORT);
  assert.equal(hostServerPortFromEnv({ KING_AI_HOST_PORT: "8801" }), 8801);
  assert.equal(hostServerPortFromEnv({ KING_AI_HOST_PORT: "8802" }), 8802);
  assert.throws(() => hostServerPortFromEnv({ KING_AI_HOST_PORT: "99999" }), /between 0 and 65535/);
});

test("createHostStatusServer serves read-only app endpoints", async (t) => {
  const readState = async () => ({
    version: "0.1.0",
    pid: 123,
    startedAt: "2026-06-02T00:00:00.000Z",
    computerId: "demo-computer",
    agents: [{
      id: "demo-agent",
      name: "Demo Agent",
      engine: "codex",
      updatedAt: "2026-06-02T00:00:01.000Z",
      runStats: {
        turns: 1,
        completed: 1,
        failed: 0,
        inputTokens: 5,
        cacheReadInputTokens: 2,
        outputTokens: 8,
        totalTokens: 15
      }
    }],
    events: [{ at: "2026-06-02T00:00:01.000Z", kind: "agent.started" }]
  });
  const usagePricing = () => [{
    key: "codex:*",
    currency: "USD",
    inputPerMillionTokens: 2,
    cacheReadInputPerMillionTokens: 0.5,
    outputPerMillionTokens: 10
  }];
  const server = await startHostStatusServer({
    port: 0,
    readState,
    tokenBudget: () => 100,
    usagePricing,
    readTimeline: async () => [{
      at: "2026-06-02T00:00:02.000Z",
      type: "host.command",
      command: "status",
      ok: true,
      exitCode: 0,
      destructive: false,
      durationMs: 3
    }],
    runCommand: (request) => runHostCommand(request, {
      readState,
      tokenBudget: () => 100,
      usagePricing,
      collectDoctorResults: async () => [{
        id: "codex",
        installed: true,
        big: { ok: true, detail: "ok" },
        small: { ok: true, detail: "ok" }
      }],
      availableEngines: () => ["codex"],
      recordTimeline: true
    })
  });
  t.after(async () => {
    server.close();
    await once(server, "close").catch(() => undefined);
  });

  const address = server.address();
  assert.equal(typeof address, "object");
  const port = typeof address === "object" && address ? address.port : 0;

  const health = await fetch(`http://127.0.0.1:${port}/health`).then((res) => res.json()) as { ok?: boolean; readOnly?: boolean };
  assert.equal(health.ok, true);
  assert.equal(health.readOnly, true);

  const corsHealth = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { Origin: "http://localhost:5173" }
  });
  assert.equal(corsHealth.headers.get("access-control-allow-origin"), "http://localhost:5173");

  const corsPreflight = await fetch(`http://127.0.0.1:${port}/runs/preflight`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://127.0.0.1:5173",
      "Access-Control-Request-Method": "POST"
    }
  });
  assert.equal(corsPreflight.status, 204);
  assert.equal(corsPreflight.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");
  assert.match(corsPreflight.headers.get("access-control-allow-methods") ?? "", /PATCH/);
  assert.match(corsPreflight.headers.get("access-control-allow-methods") ?? "", /DELETE/);

  const deletePreflight = await fetch(`http://127.0.0.1:${port}/runs/preflight`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:5173",
      "Access-Control-Request-Method": "DELETE"
    }
  });
  assert.equal(deletePreflight.status, 204);
  assert.match(deletePreflight.headers.get("access-control-allow-methods") ?? "", /DELETE/);

  const rejectedPreflight = await fetch(`http://127.0.0.1:${port}/runs/preflight`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://example.com",
      "Access-Control-Request-Method": "POST"
    }
  });
  assert.equal(rejectedPreflight.status, 403);

  const status = await fetch(`http://127.0.0.1:${port}/status`).then((res) => res.json()) as { ok?: boolean; computerId?: string };
  assert.equal(status.ok, true);
  assert.equal(status.computerId, "demo-computer");

  const snapshot = await fetch(`http://127.0.0.1:${port}/host/snapshot?limit=1`).then((res) => res.json()) as {
    ok?: boolean;
    status?: { computerId?: string };
    capabilities?: { streams?: string[] };
    timeline?: Array<{ command?: string }>;
    runs?: unknown[];
  };
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.status?.computerId, "demo-computer");
  assert.equal(snapshot.capabilities?.streams?.includes("GET /host/stream"), true);
  assert.equal(snapshot.timeline?.[0]?.command, "status");
  assert.equal(Array.isArray(snapshot.runs), true);

  const text = await fetch(`http://127.0.0.1:${port}/status.txt`).then((res) => res.text());
  assert.match(text, /host status: 0\.1\.0 pid=123/);

  const events = await fetch(`http://127.0.0.1:${port}/events`).then((res) => res.json()) as { events?: Array<{ kind: string }> };
  assert.equal(events.events?.[0]?.kind, "agent.started");

  const streamController = new AbortController();
  const stream = await fetch(`http://127.0.0.1:${port}/status/stream?interval=1000`, { signal: streamController.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = stream.body?.getReader();
  assert.ok(reader);
  const firstChunk = await reader.read();
  streamController.abort();
  const firstFrame = new TextDecoder().decode(firstChunk.value);
  assert.match(firstFrame, /event: status/);
  assert.match(firstFrame, /"computerId":"demo-computer"/);

  const hostStreamController = new AbortController();
  const hostStream = await fetch(`http://127.0.0.1:${port}/host/stream?interval=1000&limit=1`, { signal: hostStreamController.signal });
  assert.equal(hostStream.status, 200);
  assert.match(hostStream.headers.get("content-type") ?? "", /text\/event-stream/);
  const hostStreamReader = hostStream.body?.getReader();
  assert.ok(hostStreamReader);
  const hostStreamChunk = await hostStreamReader.read();
  hostStreamController.abort();
  const hostStreamFrame = new TextDecoder().decode(hostStreamChunk.value);
  assert.match(hostStreamFrame, /event: status/);
  assert.match(hostStreamFrame, /"computerId":"demo-computer"/);

  const timelineStreamController = new AbortController();
  const timelineStream = await fetch(`http://127.0.0.1:${port}/timeline/stream?interval=1000&limit=1`, { signal: timelineStreamController.signal });
  assert.equal(timelineStream.status, 200);
  assert.match(timelineStream.headers.get("content-type") ?? "", /text\/event-stream/);
  const timelineReader = timelineStream.body?.getReader();
  assert.ok(timelineReader);
  const timelineChunk = await timelineReader.read();
  timelineStreamController.abort();
  const timelineFrame = new TextDecoder().decode(timelineChunk.value);
  assert.match(timelineFrame, /event: timeline/);
  assert.match(timelineFrame, /"command":"status"/);

  const commands = await fetch(`http://127.0.0.1:${port}/commands`).then((res) => res.json()) as {
    commands?: Array<{ name: string; destructive: boolean }>;
  };
  assert.deepEqual(commands.commands?.map((entry) => entry.name), EXPECTED_HOST_COMMANDS);
  assert.deepEqual(commands.commands?.filter((entry) => entry.destructive).map((entry) => entry.name), ["prepare-run-layout", "export", "compact-ledger"]);

  const capabilities = await fetch(`http://127.0.0.1:${port}/capabilities`).then((res) => res.json()) as {
    ok?: boolean;
    localhostOnly?: boolean;
    remoteApi?: boolean;
    cors?: { enabled?: boolean; allowedOrigins?: string[] };
    resources?: string[];
    streams?: string[];
    safeExecutorCommands?: string[];
    destructiveCommands?: string[];
  };
  assert.equal(capabilities.ok, true);
  assert.equal(capabilities.localhostOnly, true);
  assert.equal(capabilities.remoteApi, false);
  assert.equal(capabilities.cors?.enabled, true);
  assert.equal(capabilities.cors?.allowedOrigins?.includes("http://localhost:*"), true);
  assert.equal(capabilities.resources?.includes("GET /capabilities"), true);
  assert.equal(capabilities.resources?.includes("GET /host/snapshot"), true);
  assert.equal(capabilities.resources?.includes("POST /runs/preflight"), true);
  assert.equal(capabilities.resources?.includes("POST /runs/prepare-layout"), true);
  assert.equal(capabilities.resources?.includes("GET /runs/:id/events"), true);
  assert.equal(capabilities.resources?.includes("POST /runs/:id/events"), true);
  assert.equal(capabilities.resources?.includes("GET /runs/:id/results"), true);
  assert.equal(capabilities.resources?.includes("GET /runs/:id/meta"), true);
  assert.equal(capabilities.streams?.includes("GET /host/stream"), true);
  assert.equal(capabilities.streams?.includes("GET /timeline/stream"), true);
  assert.equal(capabilities.streams?.includes("GET /runs/stream"), true);
  assert.equal(capabilities.streams?.includes("GET /runs/:id/stream"), true);
  assert.equal(capabilities.safeExecutorCommands?.includes("usage"), true);
  assert.equal(capabilities.safeExecutorCommands?.includes("expenses"), true);
  assert.equal(capabilities.safeExecutorCommands?.includes("prepare-run-layout"), false);
  assert.deepEqual(capabilities.destructiveCommands, ["prepare-run-layout", "export", "compact-ledger"]);

  const commandResult = await fetch(`http://127.0.0.1:${port}/commands/run`, {
    method: "POST",
    body: JSON.stringify({ command: "status", format: "json" })
  }).then((res) => res.json()) as { ok?: boolean; command?: string; json?: { computerId?: string } };
  assert.equal(commandResult.ok, true);
  assert.equal(commandResult.command, "status");
  assert.equal(commandResult.json?.computerId, "demo-computer");

  const timeline = await fetch(`http://127.0.0.1:${port}/timeline?limit=5`).then((res) => res.json()) as {
    ok?: boolean;
    command?: string;
    json?: { events?: Array<{ command?: string }> };
  };
  assert.equal(timeline.ok, true);
  assert.equal(timeline.command, "timeline");
  assert.equal(timeline.json?.events?.some((event) => event.command === "status"), true);

  const usage = await fetch(`http://127.0.0.1:${port}/usage`).then((res) => res.json()) as {
    ok?: boolean;
    command?: string;
    json?: { totalTokens?: number; budget?: { state?: string }; cost?: { amount?: number; currency?: string } };
  };
  assert.equal(usage.ok, true);
  assert.equal(usage.command, "usage");
  assert.equal(usage.json?.totalTokens, 15);
  assert.equal(usage.json?.budget?.state, "ok");
  assert.equal(usage.json?.cost?.currency, "USD");
  assert.equal(usage.json?.cost?.amount, 0.000091);

  const expenses = await fetch(`http://127.0.0.1:${port}/expenses`).then((res) => res.json()) as {
    ok?: boolean;
    command?: string;
    json?: { expenses?: Array<{ agentId?: string; amount?: number; currency?: string }> };
  };
  assert.equal(expenses.ok, true);
  assert.equal(expenses.command, "expenses");
  assert.equal(expenses.json?.expenses?.[0]?.agentId, "demo-agent");
  assert.equal(expenses.json?.expenses?.[0]?.currency, "USD");
  assert.equal(expenses.json?.expenses?.[0]?.amount, 0.000091);

  const doctor = await fetch(`http://127.0.0.1:${port}/doctor`).then((res) => res.json()) as {
    ok?: boolean;
    command?: string;
    json?: { results?: Array<{ id?: string }>; exitCode?: number };
  };
  assert.equal(doctor.ok, true);
  assert.equal(doctor.command, "doctor");
  assert.equal(doctor.json?.results?.[0]?.id, "codex");
  assert.equal(doctor.json?.exitCode, 0);

  const planRun = await fetch(`http://127.0.0.1:${port}/commands/run`, {
    method: "POST",
    body: JSON.stringify({ command: "plan-run", input: { goal: "review this repo", options: { engine: "codex" } } })
  }).then((res) => res.json()) as { ok?: boolean; json?: { spec?: { goal?: string }; options?: { engine?: string } } };
  assert.equal(planRun.ok, true);
  assert.equal(planRun.json?.spec?.goal, "review this repo");
  assert.equal(planRun.json?.options?.engine, "codex");

  const planRunResource = await fetch(`http://127.0.0.1:${port}/runs/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal: "resource plan", options: { engine: "codex" } })
  }).then((res) => res.json()) as { ok?: boolean; command?: string; json?: { spec?: { goal?: string }; options?: { engine?: string } } };
  assert.equal(planRunResource.ok, true);
  assert.equal(planRunResource.command, "plan-run");
  assert.equal(planRunResource.json?.spec?.goal, "resource plan");
  assert.equal(planRunResource.json?.options?.engine, "codex");

  const preflightResource = await fetch(`http://127.0.0.1:${port}/runs/preflight`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal: "resource preflight", options: { engine: "codex" } })
  }).then((res) => res.json()) as { ok?: boolean; command?: string; json?: { spec?: { goal?: string }; ready?: boolean } };
  assert.equal(preflightResource.ok, true);
  assert.equal(preflightResource.command, "preflight");
  assert.equal(preflightResource.json?.spec?.goal, "resource preflight");
  assert.equal(preflightResource.json?.ready, true);

  const prepareLayoutBlocked = await fetch(`http://127.0.0.1:${port}/runs/prepare-layout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal: "resource layout", options: { engine: "codex" } })
  }).then((res) => res.json()) as { ok?: boolean; exitCode?: number };
  assert.equal(prepareLayoutBlocked.ok, false);
  assert.equal(prepareLayoutBlocked.exitCode, 75);

  const policy = await fetch(`http://127.0.0.1:${port}/commands/run`, {
    method: "POST",
    body: JSON.stringify({ command: "policy", input: { command: "export" } })
  }).then((res) => res.json()) as { ok?: boolean; json?: { requiredConfirmation?: string } };
  assert.equal(policy.ok, false);
  assert.equal(policy.json?.requiredConfirmation, "allow:export");

  const policyResource = await fetch(`http://127.0.0.1:${port}/policy/export`).then((res) => res.json()) as {
    ok?: boolean;
    command?: string;
    json?: { decision?: string; requiredConfirmation?: string };
  };
  assert.equal(policyResource.ok, false);
  assert.equal(policyResource.command, "policy");
  assert.equal(policyResource.json?.decision, "confirm_required");
  assert.equal(policyResource.json?.requiredConfirmation, "allow:export");

  const confirmedPolicy = await fetch(`http://127.0.0.1:${port}/policy/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmation: "allow:export" })
  }).then((res) => res.json()) as { ok?: boolean; json?: { decision?: string } };
  assert.equal(confirmedPolicy.ok, true);
  assert.equal(confirmedPolicy.json?.decision, "allow");

  const badPlanRun = await fetch(`http://127.0.0.1:${port}/commands/run`, {
    method: "POST",
    body: JSON.stringify({ command: "plan-run", input: {} })
  });
  assert.equal(badPlanRun.status, 400);

  const unsupported = await fetch(`http://127.0.0.1:${port}/commands/run`, {
    method: "POST",
    body: JSON.stringify({ command: "restart" })
  });
  assert.equal(unsupported.status, 400);

  const missing = await fetch(`http://127.0.0.1:${port}/missing`);
  assert.equal(missing.status, 404);

  const post = await fetch(`http://127.0.0.1:${port}/status`, { method: "POST" });
  assert.equal(post.status, 405);

  const badPolicyMethod = await fetch(`http://127.0.0.1:${port}/policy/export`, { method: "PATCH" });
  assert.equal(badPolicyMethod.status, 405);

  const badPreflightMethod = await fetch(`http://127.0.0.1:${port}/runs/preflight`);
  assert.equal(badPreflightMethod.status, 405);
});

test("createHostStatusServer exposes app run request REST endpoints", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "king-ai-host-server-runs-"));
  const runsPath = join(root, "host-runs.ndjson");
  const readState = async () => ({
    version: "0.1.0",
    pid: 456,
    startedAt: "2026-06-02T00:00:00.000Z",
    computerId: "rest-computer",
    agents: [],
    events: []
  });
  const server = await startHostStatusServer({
    port: 0,
    readRuns: (input) => listHostRunRequests(input, runsPath),
    runCommand: (request) => runHostCommand(request, {
      readState,
      tokenBudget: () => null,
      availableEngines: () => ["codex"],
      runsPath
    })
  });
  t.after(async () => {
    server.close();
    await once(server, "close").catch(() => undefined);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  const eventsOutput = join(root, "events-out");
  await mkdir(eventsOutput, { recursive: true });
  await writeFile(join(eventsOutput, "loop-events.ndjson"), [
    JSON.stringify({ type: "loop.classified", runId: "rest-1", loop: 1, classification: "productive", timestamp: "2026-06-02T00:00:00.000Z" }),
    JSON.stringify({ type: "queue.backlog", runId: "rest-1", loop: 1, agent: "feedback", pendingMessages: 3, timestamp: "2026-06-02T00:00:01.000Z" })
  ].join("\n") + "\n", "utf8");
  await mkdir(join(eventsOutput, ".king-ai"), { recursive: true });
  await writeFile(join(eventsOutput, ".king-ai", "heartbeat.json"), JSON.stringify({
    schema: "king-ai.host-run-heartbeat.v1",
    status: "running",
    runId: "rest-1",
    lastTick: "2026-06-02T00:00:02.000Z",
    updatedAt: "2026-06-02T00:00:02.000Z",
    loopCount: 2,
    outputDir: eventsOutput
  }) + "\n", "utf8");
  await writeFile(join(eventsOutput, "meta.json"), JSON.stringify({
    schema: "king-ai.host-run-meta.v1",
    status: "prepared",
    runId: "rest-1",
    goal: "rest queued run",
    preparedAt: "2026-06-02T00:00:00.000Z",
    maxLoops: 3,
    actualLoops: 0,
    paths: {
      outputDir: eventsOutput,
      heartbeatPath: join(eventsOutput, ".king-ai", "heartbeat.json")
    }
  }) + "\n", "utf8");

  const submitted = await fetch(`${baseUrl}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal: "rest queued run", requestId: "rest-1", options: { engine: "codex", outputDir: eventsOutput } })
  }).then((res) => res.json()) as { ok?: boolean; command?: string; json?: { request?: { id?: string; status?: string } } };
  assert.equal(submitted.ok, true);
  assert.equal(submitted.command, "submit-run");
  assert.equal(submitted.json?.request?.id, "rest-1");

  const listed = await fetch(`${baseUrl}/runs?limit=5`).then((res) => res.json()) as { ok?: boolean; json?: { requests?: Array<{ id: string }> } };
  assert.equal(listed.ok, true);
  assert.equal(listed.json?.requests?.[0]?.id, "rest-1");

  const runStreamController = new AbortController();
  const runStream = await fetch(`${baseUrl}/runs/stream?limit=5&interval=1000`, { signal: runStreamController.signal });
  assert.equal(runStream.status, 200);
  assert.match(runStream.headers.get("content-type") ?? "", /text\/event-stream/);
  const runStreamReader = runStream.body?.getReader();
  assert.ok(runStreamReader);
  const runStreamChunk = await runStreamReader.read();
  runStreamController.abort();
  const runStreamFrame = new TextDecoder().decode(runStreamChunk.value);
  assert.match(runStreamFrame, /event: runs/);
  assert.match(runStreamFrame, /"id":"rest-1"/);

  const singleRunStreamController = new AbortController();
  const singleRunStream = await fetch(`${baseUrl}/runs/rest-1/stream?interval=1000`, { signal: singleRunStreamController.signal });
  assert.equal(singleRunStream.status, 200);
  assert.match(singleRunStream.headers.get("content-type") ?? "", /text\/event-stream/);
  const singleRunStreamReader = singleRunStream.body?.getReader();
  assert.ok(singleRunStreamReader);
  const singleRunStreamChunk = await singleRunStreamReader.read();
  singleRunStreamController.abort();
  const singleRunStreamFrame = new TextDecoder().decode(singleRunStreamChunk.value);
  assert.match(singleRunStreamFrame, /event: run/);
  assert.match(singleRunStreamFrame, /"id":"rest-1"/);
  assert.match(singleRunStreamFrame, /"heartbeat":\{"schema":"king-ai\.host-run-heartbeat\.v1"/);
  assert.match(singleRunStreamFrame, /"meta":\{"schema":"king-ai\.host-run-meta\.v1"/);

  const single = await fetch(`${baseUrl}/runs/rest-1`).then((res) => res.json()) as { ok?: boolean; json?: { request?: { status?: string } } };
  assert.equal(single.ok, true);
  assert.equal(single.json?.request?.status, "pending");

  const runEvents = await fetch(`${baseUrl}/runs/rest-1/events?type=loop.classified`).then((res) => res.json()) as {
    ok?: boolean;
    command?: string;
    json?: { filteredEvents?: number; summary?: { productiveRate?: number } };
  };
  assert.equal(runEvents.ok, true);
  assert.equal(runEvents.command, "watch-run");
  assert.equal(runEvents.json?.filteredEvents, 1);
  assert.equal(runEvents.json?.summary?.productiveRate, 100);
  const emittedRunEvent = await fetch(`${baseUrl}/runs/rest-1/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "app.note", message: "reviewed from app", payload: { panel: "events" } })
  }).then((res) => res.json()) as {
    ok?: boolean;
    command?: string;
    json?: { event?: { type?: string; runId?: string; source?: string; message?: string; payload?: { panel?: string } } };
  };
  assert.equal(emittedRunEvent.ok, true);
  assert.equal(emittedRunEvent.command, "emit-run-event");
  assert.equal(emittedRunEvent.json?.event?.type, "app.note");
  assert.equal(emittedRunEvent.json?.event?.runId, "rest-1");
  assert.equal(emittedRunEvent.json?.event?.source, "host-app");
  assert.equal(emittedRunEvent.json?.event?.message, "reviewed from app");
  assert.equal(emittedRunEvent.json?.event?.payload?.panel, "events");
  const appEvents = await fetch(`${baseUrl}/runs/rest-1/events?type=app.note&writeResults=false`).then((res) => res.json()) as {
    ok?: boolean;
    json?: { filteredEvents?: number; events?: Array<{ message?: string }> };
  };
  assert.equal(appEvents.ok, true);
  assert.equal(appEvents.json?.filteredEvents, 1);
  assert.equal(appEvents.json?.events?.[0]?.message, "reviewed from app");
  const runResults = await fetch(`${baseUrl}/runs/rest-1/results`).then((res) => res.json()) as {
    ok?: boolean;
    command?: string;
    json?: { rows?: Array<{ runId?: string; classification?: string }> };
  };
  assert.equal(runResults.ok, true);
  assert.equal(runResults.command, "run-results");
  assert.equal(runResults.json?.rows?.[0]?.runId, "rest-1");
  assert.equal(runResults.json?.rows?.[0]?.classification, "productive");
  const runHeartbeat = await fetch(`${baseUrl}/runs/rest-1/heartbeat`).then((res) => res.json()) as {
    ok?: boolean;
    command?: string;
    json?: { heartbeat?: { runId?: string; status?: string; loopCount?: number } };
  };
  assert.equal(runHeartbeat.ok, true);
  assert.equal(runHeartbeat.command, "run-heartbeat");
  assert.equal(runHeartbeat.json?.heartbeat?.runId, "rest-1");
  assert.equal(runHeartbeat.json?.heartbeat?.status, "running");
  assert.equal(runHeartbeat.json?.heartbeat?.loopCount, 2);
  const runMeta = await fetch(`${baseUrl}/runs/rest-1/meta`).then((res) => res.json()) as {
    ok?: boolean;
    command?: string;
    json?: { meta?: { runId?: string; status?: string; goal?: string; paths?: { heartbeatPath?: string } } };
  };
  assert.equal(runMeta.ok, true);
  assert.equal(runMeta.command, "run-meta");
  assert.equal(runMeta.json?.meta?.runId, "rest-1");
  assert.equal(runMeta.json?.meta?.status, "prepared");
  assert.equal(runMeta.json?.meta?.goal, "rest queued run");
  assert.equal(runMeta.json?.meta?.paths?.heartbeatPath, join(eventsOutput, ".king-ai", "heartbeat.json"));

  const updated = await fetch(`${baseUrl}/runs/rest-1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "completed", detail: "done" })
  }).then((res) => res.json()) as { ok?: boolean; command?: string; json?: { request?: { status?: string; detail?: string } } };
  assert.equal(updated.ok, true);
  assert.equal(updated.command, "update-run");
  assert.equal(updated.json?.request?.status, "completed");
  assert.equal(updated.json?.request?.detail, "done");
  const completedHeartbeat = await fetch(`${baseUrl}/runs/rest-1/heartbeat`).then((res) => res.json()) as {
    ok?: boolean;
    json?: { heartbeat?: { status?: string; detail?: string; loopCount?: number } };
  };
  assert.equal(completedHeartbeat.ok, true);
  assert.equal(completedHeartbeat.json?.heartbeat?.status, "completed");
  assert.equal(completedHeartbeat.json?.heartbeat?.detail, "done");
  assert.equal(completedHeartbeat.json?.heartbeat?.loopCount, 1);
  const completedMeta = await fetch(`${baseUrl}/runs/rest-1/meta`).then((res) => res.json()) as {
    ok?: boolean;
    json?: { meta?: { status?: string; detail?: string; actualLoops?: number; completedAt?: string } };
  };
  assert.equal(completedMeta.ok, true);
  assert.equal(completedMeta.json?.meta?.status, "completed");
  assert.equal(completedMeta.json?.meta?.detail, "done");
  assert.equal(completedMeta.json?.meta?.actualLoops, 1);
  assert.equal(typeof completedMeta.json?.meta?.completedAt, "string");
  const statusEvents = await fetch(`${baseUrl}/runs/rest-1/events?type=run.status&writeResults=false`).then((res) => res.json()) as {
    ok?: boolean;
    command?: string;
    json?: { filteredEvents?: number; events?: Array<{ status?: string; source?: string; detail?: string }> };
  };
  assert.equal(statusEvents.ok, true);
  assert.equal(statusEvents.command, "watch-run");
  assert.equal(statusEvents.json?.filteredEvents, 1);
  assert.equal(statusEvents.json?.events?.[0]?.status, "completed");
  assert.equal(statusEvents.json?.events?.[0]?.source, "update-run");
  assert.equal(statusEvents.json?.events?.[0]?.detail, "done");

  const missing = await fetch(`${baseUrl}/runs/does-not-exist`);
  assert.equal(missing.status, 404);

  await fetch(`${baseUrl}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      goal: "rest execute status",
      requestId: "rest-exec-1",
      executor: {
        kind: "host-command",
        command: "status",
        format: "json"
      }
    })
  });
  const executed = await fetch(`${baseUrl}/runs/rest-exec-1/execute`, { method: "POST" }).then((res) => res.json()) as {
    ok?: boolean;
    command?: string;
    json?: { request?: { id?: string; status?: string }; commandResult?: { command?: string } };
  };
  assert.equal(executed.ok, true);
  assert.equal(executed.command, "execute-run");
  assert.equal(executed.json?.request?.id, "rest-exec-1");
  assert.equal(executed.json?.request?.status, "completed");
  assert.equal(executed.json?.commandResult?.command, "status");

  await fetch(`${baseUrl}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      goal: "rest execute next",
      requestId: "rest-exec-2",
      executor: {
        kind: "host-command",
        command: "usage",
        format: "json"
      }
    })
  });
  const executedNext = await fetch(`${baseUrl}/runs/execute`, { method: "POST" }).then((res) => res.json()) as {
    ok?: boolean;
    json?: { request?: { id?: string; status?: string } };
  };
  assert.equal(executedNext.ok, true);
  assert.equal(executedNext.json?.request?.id, "rest-exec-2");
  assert.equal(executedNext.json?.request?.status, "completed");

  const badMethod = await fetch(`${baseUrl}/runs/rest-1/execute`, { method: "GET" });
  assert.equal(badMethod.status, 405);
});

test("createHostStatusServer exposes app export REST endpoints with policy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "king-ai-host-server-exports-"));
  const workspaceRoot = join(root, "workspace");
  const outputDir = join(root, "deliverables");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "note.txt"), "ready\n");
  const server = await startHostStatusServer({
    port: 0,
    runCommand: (request) => runHostCommand(request, {
      tokenBudget: () => null
    })
  });
  t.after(async () => {
    server.close();
    await once(server, "close").catch(() => undefined);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const plan = await fetch(`${baseUrl}/exports/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceRoot, outputDir, runId: "rest-export-1" })
  }).then((res) => res.json()) as { ok?: boolean; command?: string; json?: { runId?: string; workspaceFileCount?: number } };
  assert.equal(plan.ok, true);
  assert.equal(plan.command, "plan-export");
  assert.equal(plan.json?.runId, "rest-export-1");
  assert.equal(plan.json?.workspaceFileCount, 1);

  const blocked = await fetch(`${baseUrl}/exports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceRoot, outputDir, runId: "rest-export-1" })
  }).then((res) => res.json()) as { ok?: boolean; exitCode?: number; error?: string };
  assert.equal(blocked.ok, false);
  assert.equal(blocked.exitCode, 75);
  assert.equal(blocked.error, "host command confirmation required");

  const exported = await fetch(`${baseUrl}/exports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceRoot, outputDir, runId: "rest-export-1", confirmation: "allow:export" })
  }).then((res) => res.json()) as { ok?: boolean; command?: string; json?: { writtenFiles?: string[] } };
  assert.equal(exported.ok, true);
  assert.equal(exported.command, "export");
  assert.equal(exported.json?.writtenFiles?.some((file) => file.endsWith("workspace")), true);
  assert.equal(exported.json?.writtenFiles?.some((file) => file.endsWith("meta.json")), true);

  const badMethod = await fetch(`${baseUrl}/exports/plan`);
  assert.equal(badMethod.status, 405);
});

test("createHostStatusServer handles request errors", async () => {
  const server = createHostStatusServer({
    readState: async () => {
      throw new Error("state read failed");
    },
    tokenBudget: () => null
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    assert.equal(res.status, 500);
    assert.match(await res.text(), /state read failed/);
  } finally {
    server.close();
    await once(server, "close").catch(() => undefined);
  }
});

test("startHostStatusServer can auto-consume host run requests", async (t) => {
  let calls = 0;
  const server = await startHostStatusServer({
    port: 0,
    executeRuns: true,
    executeRunsIntervalMs: 5,
    runCommand: async (request) => {
      if (request.command === "execute-run") {
        calls += 1;
        return {
          ok: true,
          command: "execute-run",
          exitCode: 0,
          text: "no executable host run requests",
          json: { summary: "no executable host run requests" }
        };
      }
      return {
        ok: false,
        command: request.command,
        exitCode: 64,
        text: "unsupported",
        error: "unsupported"
      };
    }
  });
  t.after(async () => {
    server.close();
    await once(server, "close").catch(() => undefined);
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls > 0, true);
});
