import { appendHostLoopEvent } from "./host-loop-events.js";
import { hostRunHeartbeatPathForOutputDir, writeHostRunHeartbeat } from "./host-run-heartbeat.js";
import { hostRunMetaPathForOutputDir, updateHostRunMeta } from "./host-run-meta.js";
import { formatHostRunRequestSummary, listHostRunRequests, updateHostRunRequest } from "./host-runs.js";
import type { HostRunRequest, HostRunRequestStatus } from "./host-runs.js";
import { runHostCommand } from "./host-control.js";
import type { HostCommandRequest, HostCommandResult, HostCommandRunnerDeps } from "./host-control.js";

export interface HostRunExecuteInput {
  id?: string;
}

export interface HostRunExecuteResult {
  request?: HostRunRequest;
  commandResult?: HostCommandResult;
  summary: string;
}

const EXECUTOR_SAFE_COMMANDS = new Set([
  "status",
  "usage",
  "expenses",
  "events",
  "timeline",
  "policy",
  "doctor",
  "plan-run",
  "preflight",
  "plan-export"
]);

export function listSafeHostExecutorCommands(): string[] {
  return [...EXECUTOR_SAFE_COMMANDS];
}

export async function executeNextHostRunRequest(
  input: HostRunExecuteInput = {},
  deps: HostCommandRunnerDeps = {}
): Promise<HostRunExecuteResult> {
  const request = await selectExecutableRequest(input, deps);
  if (!request) {
    return { summary: "no executable host run requests" };
  }
  if (!request.executor) {
    return { request, summary: `host run request ${request.id} has no executor` };
  }
  const command = request.executor.command.trim().toLowerCase();
  if (!EXECUTOR_SAFE_COMMANDS.has(command)) {
    const failed = await updateHostRunRequest({
      id: request.id,
      status: "failed",
      detail: `executor command is not allowed: ${request.executor.command}`,
      result: {
        command: request.executor.command,
        ok: false,
        exitCode: 64,
        error: "executor command is not allowed"
      }
    }, {
      path: deps.runsPath,
      now: deps.now
    });
    await writeRequestHeartbeat(failed.request, "failed", {
      detail: failed.request.detail,
      command: request.executor.command,
      exitCode: 64,
      loopCount: 0,
      now: deps.now
    });
    await writeRequestMeta(failed.request, "failed", {
      detail: failed.request.detail,
      command: request.executor.command,
      exitCode: 64,
      actualLoops: 0,
      now: deps.now
    });
    await writeRequestLoopEvent(failed.request, "failed", {
      detail: failed.request.detail,
      command: request.executor.command,
      exitCode: 64,
      loop: 0,
      now: deps.now
    });
    return {
      request: failed.request,
      summary: failed.summary
    };
  }

  await updateHostRunRequest({
    id: request.id,
    status: "running",
    detail: `executing ${command}`
  }, {
    path: deps.runsPath,
    now: deps.now
  });
  await writeRequestHeartbeat(request, "running", {
    detail: `executing ${command}`,
    command,
    loopCount: 0,
    now: deps.now
  });
  await writeRequestMeta(request, "running", {
    detail: `executing ${command}`,
    command,
    actualLoops: 0,
    now: deps.now
  });
  await writeRequestLoopEvent(request, "running", {
    detail: `executing ${command}`,
    command,
    loop: 0,
    now: deps.now
  });

  const commandResult = await runHostCommand({
    command,
    format: request.executor.format,
    input: request.executor.input,
    actorRole: request.executor.actorRole
  }, {
    ...deps,
    recordTimeline: deps.recordTimeline ?? true,
    enforcePermission: request.executor.trusted === true ? false : deps.enforcePermission
  });
  const completed = await updateHostRunRequest({
    id: request.id,
    status: commandResult.ok ? "completed" : "failed",
    detail: commandResult.ok ? `completed ${command}` : `failed ${command}`,
    result: {
      command,
      ok: commandResult.ok,
      exitCode: commandResult.exitCode,
      textPreview: compact(commandResult.text),
      error: commandResult.error
    }
  }, {
    path: deps.runsPath,
    now: deps.now
  });
  await writeRequestHeartbeat(completed.request, commandResult.ok ? "completed" : "failed", {
    detail: completed.request.detail,
    command,
    exitCode: commandResult.exitCode,
    loopCount: 1,
    now: deps.now
  });
  await writeRequestMeta(completed.request, commandResult.ok ? "completed" : "failed", {
    detail: completed.request.detail,
    command,
    exitCode: commandResult.exitCode,
    actualLoops: 1,
    now: deps.now
  });
  await writeRequestLoopEvent(completed.request, commandResult.ok ? "completed" : "failed", {
    detail: completed.request.detail,
    command,
    exitCode: commandResult.exitCode,
    loop: 1,
    now: deps.now
  });
  return {
    request: completed.request,
    commandResult,
    summary: completed.summary
  };
}

async function writeRequestMeta(
  request: HostRunRequest,
  status: Exclude<HostRunRequestStatus, "pending">,
  input: {
    detail?: string;
    command?: string;
    exitCode?: number;
    actualLoops?: number;
    now?: () => Date;
  }
): Promise<void> {
  const outputDir = request.spec.options?.outputDir;
  if (!outputDir) return;
  await updateHostRunMeta({
    file: hostRunMetaPathForOutputDir(outputDir),
    runId: request.id,
    status,
    actualLoops: input.actualLoops,
    detail: input.detail,
    command: input.command,
    exitCode: input.exitCode,
    now: input.now
  });
}

async function writeRequestLoopEvent(
  request: HostRunRequest,
  status: Exclude<HostRunRequestStatus, "pending">,
  input: {
    detail?: string;
    command?: string;
    exitCode?: number;
    loop?: number;
    now?: () => Date;
  }
): Promise<void> {
  const outputDir = request.spec.options?.outputDir;
  if (!outputDir) return;
  await appendHostLoopEvent({
    outputDir,
    event: {
      type: "run.status",
      runId: request.id,
      timestamp: (input.now ?? (() => new Date()))().toISOString(),
      status,
      detail: input.detail,
      command: input.command,
      exitCode: input.exitCode,
      loop: input.loop,
      source: "execute-run"
    }
  });
}

export function formatHostRunExecuteResult(result: HostRunExecuteResult): string {
  if (!result.request) return result.summary;
  return [
    result.summary,
    result.commandResult ? `command: ${result.commandResult.command} exit=${result.commandResult.exitCode}` : "",
    formatHostRunRequestSummary(result.request)
  ].filter(Boolean).join("\n");
}

async function selectExecutableRequest(input: HostRunExecuteInput, deps: HostCommandRunnerDeps): Promise<HostRunRequest | undefined> {
  const requests = await listHostRunRequests({ limit: 100, status: "pending" }, deps.runsPath);
  const oldestFirst = [...requests].reverse();
  if (input.id) return oldestFirst.find((request) => request.id === input.id);
  return oldestFirst.find((request) => request.executor?.kind === "host-command");
}

function compact(value: string): string | undefined {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

async function writeRequestHeartbeat(
  request: HostRunRequest,
  status: Exclude<HostRunRequestStatus, "pending">,
  input: {
    detail?: string;
    command?: string;
    exitCode?: number;
    loopCount?: number;
    now?: () => Date;
  }
): Promise<void> {
  const outputDir = request.spec.options?.outputDir;
  if (!outputDir) return;
  await writeHostRunHeartbeat({
    path: hostRunHeartbeatPathForOutputDir(outputDir),
    runId: request.id,
    status,
    outputDir,
    pid: process.pid,
    detail: input.detail,
    command: input.command,
    exitCode: input.exitCode,
    loopCount: input.loopCount,
    now: input.now
  });
}
