import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHostCommand } from "../src/host-control.js";
import { listHostRunRequests } from "../src/host-runs.js";
import { createBrowserHostSdk, createDefaultHostSdkRunOptions, createDefaultRunOptions, createEnvBackedHostSdk, createEnvBackedKingHostSdk, createHostSdk, createHostSdkTakeoverRunOptions, createRunOptions, createTakeoverRunOptions, createKingHostSdk, hostBaseUrlFromEnv, hostBaseUrlFromLocation, type KingHostSdkAdapters } from "../src/host-sdk.js";
import { startHostStatusServer } from "../src/host-server.js";

test("host SDK wraps localhost host server commands", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "king-host-sdk-"));
  const runsPath = join(root, "host-runs.ndjson");
  const workspaceRoot = join(root, "workspace");
  const outputDir = join(root, "deliverables");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "sdk-note.txt"), "ready\n");
  const server = await startHostStatusServer({
    port: 0,
    readRuns: (input) => listHostRunRequests(input, runsPath),
    readState: async () => ({
      version: "0.1.0",
      pid: 123,
      startedAt: "2026-06-02T00:00:00.000Z",
      computerId: "demo-computer",
      agents: [],
      events: [{ at: "2026-06-02T00:00:01.000Z", kind: "agent.started" }]
    }),
    tokenBudget: () => null,
    runCommand: (request) => runHostCommand(request, {
      readState: async () => ({
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
        events: []
      }),
      tokenBudget: () => 100,
      collectDoctorResults: async () => [{
        id: "codex",
        installed: true,
        big: { ok: true, detail: "ok" },
        small: { ok: true, detail: "ok" }
      }],
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
  const sdk = createHostSdk({ baseUrl: `http://127.0.0.1:${port}` });

  const health = await sdk.health();
  assert.equal(health.ok, true);
  assert.equal(health.service, "king host");

  const status = await sdk.status();
  assert.equal(status.computerId, "demo-computer");

  const snapshot = await sdk.snapshot(5);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.status.computerId, "demo-computer");
  assert.equal(snapshot.capabilities.streams.includes("GET /host/stream"), true);
  assert.equal(Array.isArray(snapshot.timeline), true);
  assert.equal(Array.isArray(snapshot.runs), true);

  const watchController = new AbortController();
  const watch = sdk.watch({ intervalMs: 1000, limit: 5, signal: watchController.signal });
  const watchedSnapshot = await watch.next();
  assert.equal(watchedSnapshot.done, false);
  assert.equal(watchedSnapshot.value.event, "snapshot");
  assert.equal(watchedSnapshot.value.data.status.computerId, "demo-computer");
  const watchedFrame = await watch.next();
  watchController.abort();
  assert.equal(watchedFrame.done, false);
  assert.equal(watchedFrame.value.event, "status");
  assert.equal(watchedFrame.value.data.computerId, "demo-computer");

  const ready = await sdk.waitForReady({ timeoutMs: 1000, intervalMs: 5, requireDaemon: true });
  assert.equal(ready.computerId, "demo-computer");

  const streamController = new AbortController();
  const stream = sdk.statusStream({ intervalMs: 1000, signal: streamController.signal });
  const streamed = await stream.next();
  streamController.abort();
  assert.equal(streamed.done, false);
  assert.equal(streamed.value.computerId, "demo-computer");

  const hostStreamController = new AbortController();
  const hostStream = sdk.hostStream({ intervalMs: 1000, limit: 5, signal: hostStreamController.signal });
  const hostFrame = await hostStream.next();
  hostStreamController.abort();
  assert.equal(hostFrame.done, false);
  assert.equal(hostFrame.value.event, "status");
  assert.equal(hostFrame.value.data.computerId, "demo-computer");

  const commands = await sdk.commands();
  assert.equal(commands.commands.some((command) => command.name === "policy"), true);

  const capabilities = await sdk.capabilities();
  assert.equal(capabilities.ok, true);
  assert.equal(capabilities.cors?.enabled, true);
  assert.equal(capabilities.cors?.allowedOrigins.includes("http://localhost:*"), true);
  assert.equal(capabilities.resources.includes("GET /capabilities"), true);
  assert.equal(capabilities.resources.includes("GET /host/snapshot"), true);
  assert.equal(capabilities.resources.includes("POST /runs/preflight"), true);
  assert.equal(capabilities.resources.includes("POST /runs/prepare-layout"), true);
  assert.equal(capabilities.resources.includes("GET /runs/:id/events"), true);
  assert.equal(capabilities.resources.includes("GET /runs/:id/results"), true);
  assert.equal(capabilities.resources.includes("GET /runs/:id/meta"), true);
  assert.equal(capabilities.streams.includes("GET /host/stream"), true);
  assert.equal(capabilities.streams.includes("GET /timeline/stream"), true);
  assert.equal(capabilities.streams.includes("GET /runs/stream"), true);
  assert.equal(capabilities.streams.includes("GET /runs/:id/stream"), true);
  assert.equal(capabilities.safeExecutorCommands.includes("usage"), true);
  assert.deepEqual(capabilities.destructiveCommands, ["prepare-run-layout", "export"]);

  const usage = await sdk.usage();
  assert.equal(usage.ok, true);
  assert.equal(usage.command, "usage");
  assert.equal(usage.json?.totalTokens, 15);
  assert.equal(usage.json?.budget?.state, "ok");

  const doctor = await sdk.doctor();
  assert.equal(doctor.ok, true);
  assert.equal(doctor.command, "doctor");
  assert.equal(doctor.json?.results[0]?.id, "codex");
  assert.equal(doctor.json?.exitCode, 0);

  const plan = await sdk.planRun({ goal: "review this repo", options: { engine: "codex" } });
  assert.equal(plan.ok, true);
  assert.equal(plan.command, "plan-run");
  assert.equal(plan.json?.spec.goal, "review this repo");

  const preflight = await sdk.preflight({ goal: "preflight this repo", options: { engine: "codex" } });
  assert.equal(preflight.ok, true);
  assert.equal(preflight.command, "preflight");
  assert.equal(preflight.json?.spec.goal, "preflight this repo");
  assert.equal(preflight.json?.ready, true);

  const layoutBlocked = await sdk.prepareRunLayout({ goal: "prepare sdk layout", options: { engine: "codex" } });
  assert.equal(layoutBlocked.ok, false);
  assert.equal(layoutBlocked.command, "prepare-run-layout");
  assert.equal(layoutBlocked.exitCode, 75);

  const run = await sdk.run("ship this feature", { engine: "codex", loops: 3, outputDir: "out" });
  assert.equal(run.ok, true);
  assert.equal(run.command, "preflight");
  assert.equal(run.json?.spec.mode, "run");
  assert.equal(run.json?.spec.goal, "ship this feature");
  assert.equal(run.json?.options.loops, 3);
  assert.equal(run.json?.options.engine, "codex");

  const aliasRun = await sdk.run("ship alias feature", { runtime: "codex", codexModel: "gpt-alias", pollInterval: 7, output: "alias-out", keep: true });
  assert.equal(aliasRun.ok, true);
  assert.equal(aliasRun.json?.options.engine, "codex");
  assert.equal(aliasRun.json?.options.model, "gpt-alias");
  assert.equal(aliasRun.json?.options.pollIntervalSeconds, 7);
  assert.equal(aliasRun.json?.options.outputDir.endsWith("alias-out"), true);
  assert.equal(aliasRun.json?.options.keepArtifacts, true);

  const workerAliasRun = await sdk.run("ship worker alias feature", {
    runtime: "codex",
    configPath: "config.json",
    workerUrl: "http://127.0.0.1:1234",
    workerModel: "local-model",
    workerKey: "worker-secret-key",
    enableBrain: false
  });
  assert.equal(workerAliasRun.ok, true);
  assert.equal(workerAliasRun.json?.options.configPath, "config.json");
  assert.equal(workerAliasRun.json?.options.workerUrl, "http://127.0.0.1:1234");
  assert.equal(workerAliasRun.json?.options.workerModel, "local-model");
  assert.equal(workerAliasRun.json?.options.workerKey, "worker-secret-key");
  assert.equal(workerAliasRun.json?.options.noBrain, true);
  assert.equal(workerAliasRun.json?.summary.includes("worker-secret-key"), false);

  const projectSpecRun = await sdk.run("ship project spec", { runtime: "codex" }, {
    githubToken: "ghp_secret",
    threadSync: {
      threadId: "thread-1",
      syncUrl: "https://sync.example/thread-1",
      syncSecret: "sync-secret"
    },
    hooks: {
      beforeRun: "prepare"
    }
  });
  assert.equal(projectSpecRun.ok, true);
  assert.equal(projectSpecRun.json?.spec.githubToken, "ghp_secret");
  assert.equal(projectSpecRun.json?.spec.threadSync?.syncSecret, "sync-secret");
  assert.deepEqual(projectSpecRun.json?.spec.hooks, { beforeRun: "prepare" });
  assert.equal(projectSpecRun.json?.summary.includes("ghp_secret"), false);
  assert.equal(projectSpecRun.json?.summary.includes("sync-secret"), false);

  const takeover = await sdk.takeover({ projectPath: process.cwd(), goalOverride: "take over repo", engine: "codex" });
  assert.equal(takeover.ok, true);
  assert.equal(takeover.json?.spec.mode, "takeover");
  assert.equal(takeover.json?.options.loopMode, "infinite");
  assert.equal(JSON.stringify(takeover).includes("null"), false);

  const preparedTakeover = await sdk.prepareTakeover({ projectPath: process.cwd(), goalOverride: "prepare takeover", runtime: "codex" });
  assert.equal(preparedTakeover.preflight.ok, true);
  assert.equal(preparedTakeover.input.mode, "takeover");
  assert.equal(preparedTakeover.input.goal, "prepare takeover");
  assert.equal(preparedTakeover.input.projectDir, process.cwd());
  assert.equal(preparedTakeover.runOptions.infinite, true);
  assert.equal(preparedTakeover.runOptions.engine, "codex");

  const preparedWatchController = new AbortController();
  const preparedWatch = sdk.executePreparedTakeover(
    preparedTakeover,
    { requestId: "sdk-prepared-takeover-1" },
    { intervalMs: 1000, signal: preparedWatchController.signal }
  );
  const preparedSubmitted = await preparedWatch.next();
  assert.equal(preparedSubmitted.done, false);
  assert.equal(preparedSubmitted.value.event, "submitted");
  assert.equal(preparedSubmitted.value.data.json?.request.id, "sdk-prepared-takeover-1");
  assert.equal(preparedSubmitted.value.data.json?.request.spec.mode, "takeover");
  const preparedRun = await preparedWatch.next();
  preparedWatchController.abort();
  assert.equal(preparedRun.done, false);
  assert.equal(preparedRun.value.event, "run");
  assert.equal(preparedRun.value.data?.id, "sdk-prepared-takeover-1");

  const preparedStateWatchController = new AbortController();
  const preparedStateWatch = sdk.executePreparedTakeoverState(
    preparedTakeover,
    { requestId: "sdk-prepared-takeover-state-1" },
    { intervalMs: 1000, signal: preparedStateWatchController.signal }
  );
  const preparedStateSubmitted = await preparedStateWatch.next();
  assert.equal(preparedStateSubmitted.done, false);
  assert.equal(preparedStateSubmitted.value.event, "submitted");
  assert.equal(preparedStateSubmitted.value.data.json?.request.id, "sdk-prepared-takeover-state-1");
  assert.equal(preparedStateSubmitted.value.data.json?.request.spec.mode, "takeover");
  const preparedStateRun = await preparedStateWatch.next();
  preparedStateWatchController.abort();
  assert.equal(preparedStateRun.done, false);
  assert.equal(preparedStateRun.value.event, "state");
  assert.equal(preparedStateRun.value.data.request?.id, "sdk-prepared-takeover-state-1");

  const submitted = await sdk.submitRun({ goal: "queue this run", requestId: "sdk-request-1", options: { engine: "codex" } });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.json?.request.id, "sdk-request-1");

  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "loop-events.ndjson"), [
    JSON.stringify({ type: "loop.classified", runId: "sdk-events-1", loop: 1, classification: "idle", timestamp: "2026-06-02T00:00:00.000Z" }),
    JSON.stringify({ type: "loop.classified", runId: "sdk-events-1", loop: 2, classification: "productive", timestamp: "2026-06-02T00:00:01.000Z" })
  ].join("\n") + "\n", "utf8");
  await mkdir(join(outputDir, ".king"), { recursive: true });
  await writeFile(join(outputDir, ".king", "heartbeat.json"), JSON.stringify({
    schema: "king.host-run-heartbeat.v1",
    status: "completed",
    runId: "sdk-events-1",
    lastTick: "2026-06-02T00:00:02.000Z",
    updatedAt: "2026-06-02T00:00:02.000Z",
    loopCount: 2,
    outputDir
  }) + "\n", "utf8");
  await writeFile(join(outputDir, "meta.json"), JSON.stringify({
    schema: "king.host-run-meta.v1",
    status: "prepared",
    runId: "sdk-events-1",
    goal: "queue event run",
    preparedAt: "2026-06-02T00:00:00.000Z",
    maxLoops: "infinite",
    actualLoops: 0,
    paths: {
      outputDir,
      heartbeatPath: join(outputDir, ".king", "heartbeat.json")
    }
  }) + "\n", "utf8");
  const eventRun = await sdk.submitRun({ goal: "queue event run", requestId: "sdk-events-1", options: { engine: "codex", outputDir } });
  assert.equal(eventRun.ok, true);
  const runEvents = await sdk.runEvents("sdk-events-1", { classification: "productive" });
  assert.equal(runEvents.ok, true);
  assert.equal(runEvents.command, "watch-run");
  assert.equal(runEvents.json?.filteredEvents, 1);
  assert.equal(runEvents.json?.summary.productiveRate, 100);
  const emittedSdkEvent = await sdk.emitRunEvent("sdk-events-1", {
    type: "app.note",
    message: "sdk reviewed",
    payload: { view: "timeline" }
  });
  assert.equal(emittedSdkEvent.ok, true);
  assert.equal(emittedSdkEvent.command, "emit-run-event");
  assert.equal(emittedSdkEvent.json?.event.type, "app.note");
  assert.equal(emittedSdkEvent.json?.event.runId, "sdk-events-1");
  assert.equal(emittedSdkEvent.json?.event.source, "host-app");
  assert.equal(emittedSdkEvent.json?.event.message, "sdk reviewed");
  assert.deepEqual(emittedSdkEvent.json?.event.payload, { view: "timeline" });
  const sdkAppEvents = await sdk.runEvents("sdk-events-1", { type: "app.note", writeResults: false });
  assert.equal(sdkAppEvents.ok, true);
  assert.equal(sdkAppEvents.json?.filteredEvents, 1);
  assert.equal(sdkAppEvents.json?.events[0]?.message, "sdk reviewed");
  const runResults = await sdk.runResults("sdk-events-1");
  assert.equal(runResults.ok, true);
  assert.equal(runResults.command, "run-results");
  assert.equal(runResults.json?.rows.length, 2);
  assert.equal(runResults.json?.rows[1]?.classification, "productive");
  const runHeartbeat = await sdk.runHeartbeat("sdk-events-1");
  assert.equal(runHeartbeat.ok, true);
  assert.equal(runHeartbeat.command, "run-heartbeat");
  assert.equal(runHeartbeat.json?.heartbeat?.status, "completed");
  assert.equal(runHeartbeat.json?.heartbeat?.loopCount, 2);
  const runMeta = await sdk.runMeta("sdk-events-1");
  assert.equal(runMeta.ok, true);
  assert.equal(runMeta.command, "run-meta");
  assert.equal(runMeta.json?.meta?.status, "prepared");
  assert.equal(runMeta.json?.meta?.maxLoops, "infinite");
  assert.equal(runMeta.json?.meta?.paths?.heartbeatPath, join(outputDir, ".king", "heartbeat.json"));

  const submitWatchController = new AbortController();
  const submitWatch = sdk.submitAndWatchRun(
    { goal: "queue and watch", requestId: "sdk-watch-1", options: { engine: "codex" } },
    { intervalMs: 1000, signal: submitWatchController.signal }
  );
  const submitWatchSubmitted = await submitWatch.next();
  assert.equal(submitWatchSubmitted.done, false);
  assert.equal(submitWatchSubmitted.value.event, "submitted");
  assert.equal(submitWatchSubmitted.value.data.json?.request.id, "sdk-watch-1");
  const submitWatchRun = await submitWatch.next();
  submitWatchController.abort();
  assert.equal(submitWatchRun.done, false);
  assert.equal(submitWatchRun.value.event, "run");
  assert.equal(submitWatchRun.value.data?.id, "sdk-watch-1");

  const submitStateWatchController = new AbortController();
  const submitStateWatch = sdk.submitAndWatchRunState(
    { goal: "queue and watch state", requestId: "sdk-watch-state-1", options: { engine: "codex", outputDir } },
    { intervalMs: 1000, signal: submitStateWatchController.signal }
  );
  const submitStateSubmitted = await submitStateWatch.next();
  assert.equal(submitStateSubmitted.done, false);
  assert.equal(submitStateSubmitted.value.event, "submitted");
  assert.equal(submitStateSubmitted.value.data.json?.request.id, "sdk-watch-state-1");
  const submitStateRun = await submitStateWatch.next();
  submitStateWatchController.abort();
  assert.equal(submitStateRun.done, false);
  assert.equal(submitStateRun.value.event, "state");
  assert.equal(submitStateRun.value.data.request?.id, "sdk-watch-state-1");
  assert.equal(submitStateRun.value.data.heartbeat?.status, "completed");
  assert.equal(submitStateRun.value.data.meta?.runId, "sdk-events-1");

  const runWatchController = new AbortController();
  const runWatch = sdk.runAndWatch(
    "queue friendly run",
    { engine: "codex", loops: 2, outputDir: "out" },
    { requestId: "sdk-run-watch-1" },
    { intervalMs: 1000, signal: runWatchController.signal }
  );
  const runWatchSubmitted = await runWatch.next();
  assert.equal(runWatchSubmitted.done, false);
  assert.equal(runWatchSubmitted.value.event, "submitted");
  assert.equal(runWatchSubmitted.value.data.json?.request.id, "sdk-run-watch-1");
  assert.equal(runWatchSubmitted.value.data.json?.request.spec.options?.engine, "codex");
  assert.equal(runWatchSubmitted.value.data.json?.request.spec.options?.loops, 2);
  const runWatchRun = await runWatch.next();
  runWatchController.abort();
  assert.equal(runWatchRun.done, false);
  assert.equal(runWatchRun.value.event, "run");
  assert.equal(runWatchRun.value.data?.id, "sdk-run-watch-1");

  const runStateWatchController = new AbortController();
  const runStateWatch = sdk.runAndWatchState(
    "queue friendly state run",
    { engine: "codex", loops: 2, outputDir },
    { requestId: "sdk-run-watch-state-1" },
    { intervalMs: 1000, signal: runStateWatchController.signal }
  );
  const runStateWatchSubmitted = await runStateWatch.next();
  assert.equal(runStateWatchSubmitted.done, false);
  assert.equal(runStateWatchSubmitted.value.event, "submitted");
  assert.equal(runStateWatchSubmitted.value.data.json?.request.id, "sdk-run-watch-state-1");
  const runStateWatchRun = await runStateWatch.next();
  runStateWatchController.abort();
  assert.equal(runStateWatchRun.done, false);
  assert.equal(runStateWatchRun.value.event, "state");
  assert.equal(runStateWatchRun.value.data.request?.id, "sdk-run-watch-state-1");
  assert.equal(runStateWatchRun.value.data.heartbeat?.loopCount, 2);

  const takeoverWatchController = new AbortController();
  const takeoverWatch = sdk.takeoverAndWatch(
    { projectPath: process.cwd(), goalOverride: "watch takeover", engine: "codex" },
    {},
    { requestId: "sdk-takeover-watch-1" },
    { intervalMs: 1000, signal: takeoverWatchController.signal }
  );
  const takeoverWatchSubmitted = await takeoverWatch.next();
  assert.equal(takeoverWatchSubmitted.done, false);
  assert.equal(takeoverWatchSubmitted.value.event, "submitted");
  assert.equal(takeoverWatchSubmitted.value.data.json?.request.id, "sdk-takeover-watch-1");
  assert.equal(takeoverWatchSubmitted.value.data.json?.request.spec.mode, "takeover");
  assert.equal(takeoverWatchSubmitted.value.data.json?.request.spec.options?.loopMode, "infinite");
  const takeoverWatchRun = await takeoverWatch.next();
  takeoverWatchController.abort();
  assert.equal(takeoverWatchRun.done, false);
  assert.equal(takeoverWatchRun.value.event, "run");
  assert.equal(takeoverWatchRun.value.data?.id, "sdk-takeover-watch-1");

  const takeoverStateWatchController = new AbortController();
  const takeoverStateWatch = sdk.takeoverAndWatchState(
    { projectPath: process.cwd(), goalOverride: "watch takeover state", engine: "codex", outputDir },
    {},
    { requestId: "sdk-takeover-watch-state-1" },
    { intervalMs: 1000, signal: takeoverStateWatchController.signal }
  );
  const takeoverStateSubmitted = await takeoverStateWatch.next();
  assert.equal(takeoverStateSubmitted.done, false);
  assert.equal(takeoverStateSubmitted.value.event, "submitted");
  assert.equal(takeoverStateSubmitted.value.data.json?.request.spec.mode, "takeover");
  const takeoverStateRun = await takeoverStateWatch.next();
  takeoverStateWatchController.abort();
  assert.equal(takeoverStateRun.done, false);
  assert.equal(takeoverStateRun.value.event, "state");
  assert.equal(takeoverStateRun.value.data.request?.id, "sdk-takeover-watch-state-1");
  assert.equal(takeoverStateRun.value.data.meta?.paths?.heartbeatPath, join(outputDir, ".king", "heartbeat.json"));

  const requests = await sdk.runRequests(20);
  assert.equal(requests.ok, true);
  assert.equal(requests.json?.requests.some((request) => request.id === "sdk-request-1"), true);

  const runStreamController = new AbortController();
  const runStream = sdk.runRequestsStream({ intervalMs: 1000, limit: 20, signal: runStreamController.signal });
  const streamedRuns = await runStream.next();
  runStreamController.abort();
  assert.equal(streamedRuns.done, false);
  assert.equal(streamedRuns.value.some((request) => request.id === "sdk-request-1"), true);

  const singleRunStreamController = new AbortController();
  const singleRunStream = sdk.runRequestStream("sdk-request-1", { intervalMs: 1000, signal: singleRunStreamController.signal });
  const streamedRun = await singleRunStream.next();
  singleRunStreamController.abort();
  assert.equal(streamedRun.done, false);
  assert.equal(streamedRun.value?.id, "sdk-request-1");

  const runStateStreamController = new AbortController();
  const runStateStream = sdk.runStateStream("sdk-events-1", { intervalMs: 1000, signal: runStateStreamController.signal });
  const streamedRunState = await runStateStream.next();
  runStateStreamController.abort();
  assert.equal(streamedRunState.done, false);
  assert.equal(streamedRunState.value.request?.id, "sdk-events-1");
  assert.equal(streamedRunState.value.heartbeat?.status, "completed");
  assert.equal(streamedRunState.value.meta?.runId, "sdk-events-1");

  const singleRequest = await sdk.runRequest("sdk-request-1");
  assert.equal(singleRequest.ok, true);
  assert.equal(singleRequest.json?.request.status, "pending");

  const updatedRequest = await sdk.updateRun("sdk-request-1", "completed", "done");
  assert.equal(updatedRequest.ok, true);
  assert.equal(updatedRequest.json?.request.status, "completed");

  const waitedRequest = await sdk.waitForRun("sdk-request-1", { timeoutMs: 1000, intervalMs: 5 });
  assert.equal(waitedRequest.ok, true);
  assert.equal(waitedRequest.json?.request.status, "completed");

  const completedRequests = await sdk.runRequests(5, "completed");
  assert.equal(completedRequests.json?.requests.some((request) => request.id === "sdk-request-1"), true);

  await sdk.submitRun({ goal: "complete helper", requestId: "sdk-complete-1", options: { engine: "codex" } });
  const completedHelper = await sdk.completeRun("sdk-complete-1", "accepted by app");
  assert.equal(completedHelper.ok, true);
  assert.equal(completedHelper.json?.request.status, "completed");
  assert.equal(completedHelper.json?.request.detail, "accepted by app");

  await sdk.submitRun({ goal: "fail helper", requestId: "sdk-fail-1", options: { engine: "codex" } });
  const failedHelper = await sdk.failRun("sdk-fail-1", "failed by app");
  assert.equal(failedHelper.ok, true);
  assert.equal(failedHelper.json?.request.status, "failed");
  assert.equal(failedHelper.json?.request.detail, "failed by app");

  await sdk.submitRun({ goal: "cancel helper", requestId: "sdk-cancel-1", options: { engine: "codex" } });
  const cancelledHelper = await sdk.cancelRun("sdk-cancel-1", "cancelled by app");
  assert.equal(cancelledHelper.ok, true);
  assert.equal(cancelledHelper.json?.request.status, "cancelled");
  assert.equal(cancelledHelper.json?.request.detail, "cancelled by app");

  const pending = await sdk.submitRun({ goal: "wait for pending run", requestId: "sdk-pending-1", options: { engine: "codex" } });
  assert.equal(pending.ok, true);
  await assert.rejects(
    () => sdk.waitForRun("sdk-pending-1", { timeoutMs: 20, intervalMs: 5 }),
    /last status=pending/
  );

  const executable = await sdk.submitRun({
    goal: "sdk execute status",
    requestId: "sdk-exec-1",
    executor: {
      kind: "host-command",
      command: "status",
      format: "json"
    }
  });
  assert.equal(executable.ok, true);
  const executed = await sdk.executeRun("sdk-exec-1");
  assert.equal(executed.ok, true);
  assert.equal(executed.json?.request?.status, "completed");

  const submitAndExecuted = await sdk.submitAndExecuteRun({
    goal: "sdk submit and execute usage",
    requestId: "sdk-exec-2",
    executor: {
      kind: "host-command",
      command: "usage",
      format: "json"
    }
  });
  assert.equal(submitAndExecuted.submitted.ok, true);
  assert.equal(submitAndExecuted.submitted.json?.request.id, "sdk-exec-2");
  assert.equal(submitAndExecuted.executed.ok, true);
  assert.equal(submitAndExecuted.executed.json?.request?.status, "completed");
  assert.equal(submitAndExecuted.executed.json?.commandResult?.command, "usage");

  const policy = await sdk.policy("export");
  assert.equal(policy.ok, false);
  assert.equal(policy.json?.requiredConfirmation, "allow:export");

  const confirmedPolicy = await sdk.policy("export", { confirmation: "allow:export" });
  assert.equal(confirmedPolicy.ok, true);
  assert.equal(confirmedPolicy.json?.decision, "allow");

  const blockedExport = await sdk.exportArtifacts({ outputDir: "deliverables" });
  assert.equal(blockedExport.ok, false);
  assert.equal(blockedExport.exitCode, 75);
  assert.equal(blockedExport.error, "host command confirmation required");

  const exportPlan = await sdk.planExport({ workspaceRoot, outputDir, runId: "sdk-export-1" });
  assert.equal(exportPlan.ok, true);
  assert.equal(exportPlan.json?.workspaceFileCount, 1);

  const exported = await sdk.exportArtifacts({ workspaceRoot, outputDir, runId: "sdk-export-1", confirmation: "allow:export" });
  assert.equal(exported.ok, true);
  assert.equal(exported.json?.writtenFiles.some((file) => file.endsWith("workspace")), true);
  assert.equal(exported.json?.writtenFiles.some((file) => file.endsWith("meta.json")), true);

  const timeline = await sdk.timeline(5);
  assert.equal(timeline.ok, true);
  assert.equal(Array.isArray(timeline.json?.events), true);

  const timelineStreamController = new AbortController();
  const timelineStream = sdk.timelineStream({ intervalMs: 1000, limit: 5, signal: timelineStreamController.signal });
  const streamedTimeline = await timelineStream.next();
  timelineStreamController.abort();
  assert.equal(streamedTimeline.done, false);
  assert.equal(Array.isArray(streamedTimeline.value), true);
});

test("host SDK validates base URLs", () => {
  assert.throws(() => createHostSdk({ baseUrl: "file:///tmp/host" }), /http or https/);
});

test("host SDK run option helpers normalize King aliases", () => {
  const defaults = createDefaultHostSdkRunOptions();
  assert.equal(defaults.loops, 100);
  assert.equal(defaults.pollIntervalSeconds, 15);
  assert.equal(defaults.outputDir, "./deliverables");
  assert.equal(defaults.keepArtifacts, false);
  assert.equal(defaults.workerKey, "lmstudio");
  assert.equal(defaults.noBrain, false);

  const aliases = createDefaultHostSdkRunOptions({
    runtime: "codex",
    codexModel: " gpt-test ",
    pollInterval: 7,
    output: "out",
    keep: true,
    configPath: " config.json ",
    workerUrl: " http://127.0.0.1:1234 ",
    workerModel: " local-model ",
    workerKey: " local-key ",
    enableBrain: false
  });
  assert.equal(aliases.engine, "codex");
  assert.equal(aliases.model, "gpt-test");
  assert.equal(aliases.pollIntervalSeconds, 7);
  assert.equal(aliases.outputDir, "out");
  assert.equal(aliases.keepArtifacts, true);
  assert.equal(aliases.configPath, "config.json");
  assert.equal(aliases.workerUrl, "http://127.0.0.1:1234");
  assert.equal(aliases.workerModel, "local-model");
  assert.equal(aliases.workerKey, "local-key");
  assert.equal(aliases.noBrain, true);

  const explicit = createDefaultHostSdkRunOptions({
    runtime: "claude",
    engine: "codex",
    codexModel: "gpt-alias",
    model: "gpt-explicit",
    output: "alias-out",
    outputDir: "explicit-out",
    noBrain: false,
    enableBrain: false
  });
  assert.equal(explicit.engine, "codex");
  assert.equal(explicit.model, "gpt-explicit");
  assert.equal(explicit.outputDir, "explicit-out");
  assert.equal(explicit.noBrain, false);

  const takeover = createHostSdkTakeoverRunOptions({ loops: 2 });
  assert.equal(takeover.infinite, true);
  assert.equal(takeover.loops, Infinity);
});

test("host SDK exposes helper names", async (t) => {
  const server = await startHostStatusServer({
    port: 0,
    readState: async () => ({
      version: "0.1.0",
      pid: 765,
      startedAt: "2026-06-02T00:00:00.000Z",
      computerId: "king-sdk",
      agents: [],
      events: []
    }),
    tokenBudget: () => null
  });
  t.after(async () => {
    server.close();
    await once(server, "close").catch(() => undefined);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const defaults = createDefaultRunOptions({ runtime: "codex" });
  assert.equal(defaults.engine, "codex");
  assert.equal(defaults.workerKey, "lmstudio");
  assert.equal(createRunOptions({ loops: 4 }).loops, 4);
  assert.equal(createTakeoverRunOptions().infinite, true);

  const sdk = createKingHostSdk({ baseUrl: `http://127.0.0.1:${port}` });
  assert.equal((await sdk.status()).computerId, "king-sdk");
});

test("host SDK supports King adapter factories", async () => {
  interface ConcreteTakeoverOptions {
    projectPath: string;
    goalOverride?: string;
    runtime: "claude" | "codex";
    enableBrain: boolean;
  }
  const preparedPlan = { id: "plan-1" };
  const calls: Array<{ name: string; value: unknown }> = [];
  const adapters: KingHostSdkAdapters<Record<string, never>, typeof preparedPlan, ConcreteTakeoverOptions> = {
    async runGoal(goal, options, spec, bindings) {
      calls.push({ name: "runGoal", value: { goal, options, spec, bindings } });
    },
    prepareTakeoverPlan(options) {
      calls.push({ name: "prepareTakeoverPlan", value: options });
      return preparedPlan;
    },
    async executePreparedTakeoverPlan(plan, options, bindings) {
      calls.push({ name: "executePreparedTakeoverPlan", value: { plan, options, bindings } });
    },
    normalizeTakeoverOptions(options) {
      if ("runtime" in options && typeof options.runtime === "string") return options as ConcreteTakeoverOptions;
      return {
        projectPath: options.projectPath ?? ".",
        goalOverride: options.goalOverride,
        runtime: options.runtime ?? "claude",
        enableBrain: true
      };
    }
  };

  const sdk = createEnvBackedKingHostSdk({ CUSTOM_VAR: "custom-value" }, {}, adapters);
  await sdk.run("ship adapter feature", { runtime: "codex", loops: 2, enableBrain: false, workerUrl: "http://127.0.0.1:1234" }, {});
  const runCall = calls.find((call) => call.name === "runGoal")?.value as {
    goal: string;
    options: { engine?: string; loops?: number; noBrain?: boolean; workerUrl?: string };
    bindings: { hostEnv: Record<string, string | undefined> };
  };
  assert.equal(runCall.goal, "ship adapter feature");
  assert.equal(runCall.options.engine, "codex");
  assert.equal(runCall.options.loops, 2);
  assert.equal(runCall.options.noBrain, true);
  assert.equal(runCall.options.workerUrl, "http://127.0.0.1:1234");
  assert.equal(runCall.bindings.hostEnv.CUSTOM_VAR, "custom-value");

  const plan = sdk.prepareTakeover({ projectPath: "/repo", goalOverride: "stabilize release" });
  assert.equal(plan.id, "plan-1");
  assert.deepEqual(calls.find((call) => call.name === "prepareTakeoverPlan")?.value, {
    projectPath: "/repo",
    goalOverride: "stabilize release",
    runtime: "claude",
    enableBrain: true
  });

  await sdk.executePreparedTakeover(plan, { loops: 3 });
  const executeCall = calls.find((call) => call.name === "executePreparedTakeoverPlan")?.value as {
    plan: typeof preparedPlan;
    options: { infinite?: boolean; loops?: number };
  };
  assert.equal(executeCall.plan, preparedPlan);
  assert.equal(executeCall.options.infinite, true);
  assert.equal(executeCall.options.loops, Infinity);
});

test("host SDK can be configured from env", async (t) => {
  const server = await startHostStatusServer({
    port: 0,
    readState: async () => ({
      version: "0.1.0",
      pid: 321,
      startedAt: "2026-06-02T00:00:00.000Z",
      computerId: "env-computer",
      agents: [],
      events: []
    }),
    tokenBudget: () => null
  });
  t.after(async () => {
    server.close();
    await once(server, "close").catch(() => undefined);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  assert.equal(hostBaseUrlFromEnv({ KING_HOST_PORT: String(port) }), `http://127.0.0.1:${port}`);
  assert.equal(hostBaseUrlFromEnv({ KING_HOST_URL: `http://localhost:${port}` }), `http://localhost:${port}`);

  const sdk = createEnvBackedHostSdk({ KING_HOST_URL: `http://127.0.0.1:${port}` });
  assert.equal((await sdk.status()).computerId, "env-computer");
});

test("host SDK can be configured for browser localhost apps", async (t) => {
  const server = await startHostStatusServer({
    port: 0,
    readState: async () => ({
      version: "0.1.0",
      pid: 654,
      startedAt: "2026-06-02T00:00:00.000Z",
      computerId: "browser-computer",
      agents: [],
      events: []
    }),
    tokenBudget: () => null
  });
  t.after(async () => {
    server.close();
    await once(server, "close").catch(() => undefined);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  assert.equal(hostBaseUrlFromLocation({ protocol: "http:", hostname: "localhost", port: "5173", origin: "http://localhost:5173" }, { port }), `http://localhost:${port}`);
  assert.equal(hostBaseUrlFromLocation({ protocol: "http:", hostname: "example.com", port: "5173", origin: "http://example.com:5173" }, { port }), `http://127.0.0.1:${port}`);
  assert.equal(hostBaseUrlFromLocation({ protocol: "http:", hostname: "localhost", port: "5173", origin: "http://localhost:5173" }, { useCurrentOrigin: true }), "http://localhost:5173");

  const sdk = createBrowserHostSdk({
    location: { protocol: "http:", hostname: "127.0.0.1", port: "5173", origin: "http://127.0.0.1:5173" },
    port
  });
  assert.equal((await sdk.status()).computerId, "browser-computer");
});

test("host SDK streams browser ReadableStream bodies", async () => {
  let released = false;
  const chunks = [
    Buffer.from("event: status\n"),
    Buffer.from('data: {"ok":true,"version":"0.1.0","computerId":"browser-stream","agents":[],"events":[]}\n\n')
  ];
  const body = {
    getReader: () => {
      let index = 0;
      return {
        read: async () => {
          if (index >= chunks.length) return { done: true };
          return { done: false, value: chunks[index++] };
        },
        releaseLock: () => {
          released = true;
        }
      };
    }
  };
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    body,
    text: async () => "",
    url: "http://127.0.0.1:8799/status/stream"
  })) as unknown as typeof fetch;

  const sdk = createHostSdk({ baseUrl: "http://127.0.0.1:8799", fetch: fetchImpl });
  const stream = sdk.statusStream({ intervalMs: 1000 });
  const first = await stream.next();
  assert.equal(first.done, false);
  assert.equal(first.value.computerId, "browser-stream");
  const second = await stream.next();
  assert.equal(second.done, true);
  assert.equal(released, true);
});

test("host SDK waitForReady reports timeout", async () => {
  const sdk = createHostSdk({ baseUrl: "http://127.0.0.1:1" });
  await assert.rejects(
    () => sdk.waitForReady({ timeoutMs: 20, intervalMs: 5 }),
    /did not become ready/
  );
});
