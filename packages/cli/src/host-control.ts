import { collectDoctorResults, doctorExitCode, formatDoctorReport } from "./daemon.js";
import type { DoctorResult } from "./daemon.js";
import { cronMatches } from "./cron.js";
import { exportHostArtifacts, planHostExport } from "./host-export.js";
import type { HostExportInput } from "./host-export.js";
import { formatHostFeedback, formatHostFeedbackSummary, listHostFeedback, recordHostFeedback, summarizeHostFeedback } from "./host-feedback.js";
import type { HostFeedbackListInput, HostFeedbackRecordInput } from "./host-feedback.js";
import { buildHostStatusSnapshot, formatHostStatusSnapshot } from "./host-api.js";
import { buildHostAgenda, compactHostLedger, createHostCapsule, createHostTask, createHostWorkflowCard, formatHostAgenda, formatHostCapsules, formatHostLedgerCompact, formatHostTasks, formatHostWorkflowCards, listHostCapsules, listHostTasks, listHostWorkflowCards, updateHostCapsule, updateHostTask, updateHostWorkflowCard } from "./host-ledger.js";
import type { HostAgendaInput, HostCapsuleCreateInput, HostCapsuleListInput, HostCapsuleUpdateInput, HostLedgerPathInput, HostTaskCreateInput, HostTaskListInput, HostTaskUpdateInput, HostWorkflowCard, HostWorkflowCardCreateInput, HostWorkflowCardListInput, HostWorkflowCardUpdateInput } from "./host-ledger.js";
import { appendHostLoopEvent, formatHostLoopEvents, readHostLoopEvents, readHostLoopResults } from "./host-loop-events.js";
import type { HostLoopEvent, HostLoopEventsInput, HostLoopResultsInput } from "./host-loop-events.js";
import { formatHostRunHeartbeat, hostRunHeartbeatPathForOutputDir, readHostRunHeartbeat, writeHostRunHeartbeat } from "./host-run-heartbeat.js";
import type { HostRunHeartbeatReadInput } from "./host-run-heartbeat.js";
import { formatHostRunMeta, hostRunMetaPathForOutputDir, readHostRunMeta, updateHostRunMeta } from "./host-run-meta.js";
import type { HostRunMetaReadInput } from "./host-run-meta.js";
import { prepareHostRunLayout } from "./host-run-layout.js";
import type { HostRunLayoutInput } from "./host-run-layout.js";
import { executeNextHostRunRequest, formatHostRunExecuteResult } from "./host-run-executor.js";
import type { HostRunExecuteInput } from "./host-run-executor.js";
import { checkHostCommandPolicy, formatHostPolicyCheck } from "./host-policy.js";
import { evaluateHostCommandPermission, resolveActorRole, resolveHumanApproval, resolveTeamSpec } from "./host-permission.js";
import type { HostPermissionOutcome } from "./host-permission.js";
import { normalizeReviewVerdict, planHandoff, selectOwnerRole } from "./team-routing.js";
import type { HandoffAction } from "./team-routing.js";
import type { KingTeamSpec } from "./team-workflow.js";
import { createHostLaunchPlan, toJsonSafeHostLaunchPlan } from "./host-run-spec.js";
import type { HostRunSpecInput } from "./host-run-spec.js";
import { formatHostRunRequestSummary, formatHostRunRequests, getHostRunRequest, listHostRunRequests, submitHostRunRequest, updateHostRunRequest } from "./host-runs.js";
import type { HostRunGetInput, HostRunListInput, HostRunRequest, HostRunSubmitInput, HostRunUpdateInput } from "./host-runs.js";
import { appendHostTimelineEvent, formatHostTimeline, previewText, readHostTimeline, summarizeHostCommandJson } from "./host-timeline.js";
import { readRunningState } from "./service.js";
import type { RunningEvent, RunningState } from "./service.js";
import { formatUsageExpenses, formatUsageSummary, listUsageExpenses, summarizeAgentUsage, tokenBudgetFromEnv, usagePricingFromEnv } from "./usage.js";
import type { UsagePricingRule } from "./usage.js";
import { buildUsageRuntimeData } from "./runtime-data.js";

export type HostCommandName = "status" | "usage" | "expenses" | "events" | "timeline" | "policy" | "doctor" | "plan-run" | "preflight" | "prepare-run-layout" | "submit-run" | "run-requests" | "run-request" | "update-run" | "cancel-run" | "execute-run" | "task-create" | "task-list" | "task-update" | "agenda" | "capsule-create" | "capsule-list" | "capsule-update" | "workflow-create" | "workflow-list" | "workflow-update" | "initiative-create" | "handoff-create" | "review-create" | "decision-create" | "artifact-create" | "feedback-record" | "feedback-list" | "feedback-summary" | "cron-check" | "emit-run-event" | "watch-run" | "run-results" | "run-heartbeat" | "run-meta" | "plan-export" | "export" | "compact-ledger";
export type HostCommandFormat = "text" | "json";

export interface HostCommandDefinition {
  name: HostCommandName;
  description: string;
  destructive: boolean;
}

export interface HostCommandRequest {
  command: string;
  format?: HostCommandFormat;
  input?: unknown;
  actorRole?: string;
}

export interface HostCommandResult {
  ok: boolean;
  command: string;
  exitCode: number;
  text: string;
  json?: unknown;
  error?: string;
}

export interface HostCommandRunnerDeps {
  readState?: () => Promise<RunningState | null>;
  tokenBudget?: () => number | null | undefined;
  usagePricing?: () => UsagePricingRule[];
  collectDoctorResults?: () => Promise<DoctorResult[]>;
  availableEngines?: () => string[];
  recordTimeline?: boolean;
  timelinePath?: string;
  runsPath?: string;
  teamSpec?: () => KingTeamSpec | null | undefined;
  enforcePermission?: boolean;
  autoHandoff?: boolean;
  now?: () => Date;
}

const COMMANDS: HostCommandDefinition[] = [
  { name: "status", description: "Return the app-facing daemon status snapshot.", destructive: false },
  { name: "usage", description: "Summarize local agent run and token usage.", destructive: false },
  { name: "expenses", description: "List estimated local agent run expenses by agent.", destructive: false },
  { name: "events", description: "Return recent daemon lifecycle events.", destructive: false },
  { name: "timeline", description: "Return recent host command audit events.", destructive: false },
  { name: "policy", description: "Check host command safety policy and confirmation requirements.", destructive: false },
  { name: "doctor", description: "Probe local Claude/Codex engine availability.", destructive: false },
  { name: "plan-run", description: "Normalize a host app run request into a reproducible run plan.", destructive: false },
  { name: "preflight", description: "Check whether a host app run request is ready to launch.", destructive: false },
  { name: "prepare-run-layout", description: "Materialize the local host run layout after explicit confirmation.", destructive: true },
  { name: "submit-run", description: "Persist a pending host app run request for local execution.", destructive: false },
  { name: "run-requests", description: "List pending host app run requests.", destructive: false },
  { name: "run-request", description: "Return one host app run request by id.", destructive: false },
  { name: "update-run", description: "Append a lifecycle status update for a host app run request.", destructive: false },
  { name: "cancel-run", description: "Cancel a queued or active host app run request.", destructive: false },
  { name: "execute-run", description: "Consume one pending host app run request with a safe local executor.", destructive: false },
  { name: "task-create", description: "Append a local host task to the run ledger.", destructive: false },
  { name: "task-list", description: "List local host tasks from the run ledger.", destructive: false },
  { name: "task-update", description: "Append a local host task status or ownership update.", destructive: false },
  { name: "agenda", description: "Build the dependency-aware host task agenda.", destructive: false },
  { name: "capsule-create", description: "Append a repo work capsule to the run ledger.", destructive: false },
  { name: "capsule-list", description: "List repo work capsules from the run ledger.", destructive: false },
  { name: "capsule-update", description: "Append a repo work capsule update.", destructive: false },
  { name: "workflow-create", description: "Append a first-class workflow object to the run ledger.", destructive: false },
  { name: "workflow-list", description: "List first-class workflow objects from the run ledger.", destructive: false },
  { name: "workflow-update", description: "Append a first-class workflow object update.", destructive: false },
  { name: "initiative-create", description: "Append a long-running initiative workflow object.", destructive: false },
  { name: "handoff-create", description: "Append a role handoff workflow object.", destructive: false },
  { name: "review-create", description: "Append a review-request workflow object.", destructive: false },
  { name: "decision-create", description: "Append a human or role decision workflow object.", destructive: false },
  { name: "artifact-create", description: "Append an artifact workflow object.", destructive: false },
  { name: "feedback-record", description: "Append run feedback and skill metric evidence.", destructive: false },
  { name: "feedback-list", description: "List run feedback records.", destructive: false },
  { name: "feedback-summary", description: "Summarize run feedback and skill metrics.", destructive: false },
  { name: "cron-check", description: "Evaluate local cron schedules and emit matching run events.", destructive: false },
  { name: "emit-run-event", description: "Append an app-facing event to a prepared host run output.", destructive: false },
  { name: "watch-run", description: "Read King loop events from a prepared host run output.", destructive: false },
  { name: "run-results", description: "Read King results.tsv rows from a prepared host run output.", destructive: false },
  { name: "run-heartbeat", description: "Read a prepared or executing host run heartbeat file.", destructive: false },
  { name: "run-meta", description: "Read prepared host run metadata from a run output.", destructive: false },
  { name: "plan-export", description: "Preview host artifact and repo patch export outputs.", destructive: false },
  { name: "export", description: "Write host artifact and repo patch exports to the output directory.", destructive: true },
  { name: "compact-ledger", description: "Rewrite the append-only task/capsule/workflow ledgers into merged snapshots.", destructive: true }
];

export function listHostCommands(): HostCommandDefinition[] {
  return COMMANDS.map((entry) => ({ ...entry }));
}

export function normalizeHostCommandName(raw: string): HostCommandName | null {
  const value = raw.trim().toLowerCase();
  return COMMANDS.some((entry) => entry.name === value) ? value as HostCommandName : null;
}

function formatEvents(events: RunningEvent[]): string {
  if (events.length === 0) return "no recent daemon events";
  return events.map((event) => `${event.at} ${event.kind}${event.detail ? ` ${event.detail}` : ""}`).join("\n");
}

export async function runHostCommand(request: HostCommandRequest, deps: HostCommandRunnerDeps = {}): Promise<HostCommandResult> {
  const started = Date.now();
  const actorRole = resolveActorRole(request);
  let result: HostCommandResult;
  try {
    result = await executeHostCommand(request, deps);
  } catch (err) {
    const command = normalizeHostCommandName(request.command) ?? request.command;
    if (deps.recordTimeline) {
      const message = err instanceof Error ? err.message : String(err);
      await appendHostTimelineEvent({
        at: (deps.now ?? (() => new Date()))().toISOString(),
        type: "host.command",
        command,
        ok: false,
        exitCode: 1,
        destructive: listHostCommands().some((entry) => entry.name === command && entry.destructive),
        durationMs: Date.now() - started,
        actorRole,
        textPreview: previewText(message),
        error: message
      }, deps.timelinePath);
    }
    throw err;
  }

  if (deps.recordTimeline) {
    await appendHostTimelineEvent({
      at: (deps.now ?? (() => new Date()))().toISOString(),
      type: "host.command",
      command: result.command,
      ok: result.ok,
      exitCode: result.exitCode,
      destructive: listHostCommands().some((entry) => entry.name === result.command && entry.destructive),
      durationMs: Date.now() - started,
      actorRole,
      textPreview: previewText(result.text),
      jsonSummary: summarizeHostCommandJson(result.command, result.json),
      error: result.error
    }, deps.timelinePath);
  }

  return result;
}

async function executeHostCommand(request: HostCommandRequest, deps: HostCommandRunnerDeps = {}): Promise<HostCommandResult> {
  const command = normalizeHostCommandName(request.command);
  if (!command) {
    return {
      ok: false,
      command: request.command,
      exitCode: 64,
      text: `unsupported host command: ${request.command}`,
      error: "unsupported host command"
    };
  }

  if (command === "policy") {
    const input = normalizePolicyInput(request.input);
    const target = normalizeHostCommandName(input.command);
    if (!target) {
      return {
        ok: false,
        command,
        exitCode: 64,
        text: `unsupported host command: ${input.command}`,
        error: "unsupported host command"
      };
    }
    const policy = checkHostCommandPolicy(target, isDestructiveHostCommand(target), input);
    return {
      ok: policy.decision === "allow",
      command,
      exitCode: policy.decision === "allow" ? 0 : 1,
      text: formatHostPolicyCheck(policy),
      json: policy
    };
  }

  const policy = checkHostCommandPolicy(command, isDestructiveHostCommand(command), request.input as { confirmed?: unknown; confirmation?: unknown } | undefined);
  if (policy.decision !== "allow") {
    return {
      ok: false,
      command,
      exitCode: 75,
      text: formatHostPolicyCheck(policy),
      json: policy,
      error: "host command confirmation required"
    };
  }

  const permission: HostPermissionOutcome = deps.enforcePermission === false
    ? { enforced: false, action: null }
    : evaluateHostCommandPermission(command, request.input, request, { teamSpec: deps.teamSpec });
  if (permission.enforced && permission.decision === "deny") {
    return {
      ok: false,
      command,
      exitCode: 77,
      text: `role governance blocked ${permission.role} from ${permission.action} via ${command}`,
      json: { permission },
      error: "host command blocked by role governance"
    };
  }
  if (permission.enforced && permission.decision === "human-decision") {
    const approval = resolveHumanApproval(request.input, permission.role);
    if (!approval.approved) {
      const decision = await createHostWorkflowCard({
        ...ledgerPathInput(request.input),
        kind: "decision",
        title: `Human decision marker required: ${command} (${permission.action})`,
        ownerRole: permission.role,
        decisionBy: permission.rule?.requireReviewBy ?? "human",
        detail: `Role ${permission.role} requested ${permission.action} via ${command}; ${approval.reason ?? "human decision marker required"}. Retry with humanApproved=true and approvedBy=<approver different from ${permission.role}>. Role governance is opt-in for trusted local automation; omit actorRole/KING_TEAM_ROLE when this command should run unattended.`,
        metadata: { blockedCommand: command, action: permission.action, requestedRole: permission.role, reason: approval.reason }
      }, deps.now);
      return {
        ok: false,
        command,
        exitCode: 75,
        text: `human decision marker required before ${command}; created decision ${decision.id} (${approval.reason ?? "approval required"})`,
        json: { permission, decision },
        error: "host command blocked by human-decision governance"
      };
    }
  }

  if (command === "timeline") {
    const events = await readHostTimeline({
      path: deps.timelinePath,
      limit: normalizeTimelineInput(request.input).limit
    });
    return {
      ok: true,
      command,
      exitCode: 0,
      text: formatHostTimeline(events),
      json: { events }
    };
  }

  const readState = deps.readState ?? readRunningState;
  const tokenBudget = deps.tokenBudget ?? tokenBudgetFromEnv;
  const usagePricing = deps.usagePricing ?? usagePricingFromEnv;
  if (command === "plan-run" || command === "preflight") {
    const plan = createHostLaunchPlan(normalizeRunInput(request.input), process.env, normalizeAvailableEngines(deps.availableEngines?.()));
    return {
      ok: plan.ready,
      command,
      exitCode: plan.ready ? 0 : 1,
      text: plan.launchSummary,
      json: toJsonSafeHostLaunchPlan(plan)
    };
  }
  if (command === "prepare-run-layout") {
    try {
      const result = await prepareHostRunLayout(normalizeRunLayoutInput(request.input), {
        env: process.env,
        availableEngines: normalizeAvailableEngines(deps.availableEngines?.())
      });
      return {
        ok: result.launchPlan.ready,
        command,
        exitCode: result.launchPlan.ready ? 0 : 1,
        text: result.summary,
        json: result
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        command,
        exitCode: 1,
        text: message,
        error: message
      };
    }
  }
  if (command === "submit-run") {
    const result = await submitHostRunRequest(withExecutorActorRole(normalizeSubmitRunInput(request.input), permission.role), {
      path: deps.runsPath,
      availableEngines: normalizeAvailableEngines(deps.availableEngines?.()),
      now: deps.now
    });
    return {
      ok: result.launchPlan.ready,
      command,
      exitCode: result.launchPlan.ready ? 0 : 1,
      text: result.summary,
      json: result
    };
  }
  if (command === "run-requests") {
    const requests = await listHostRunRequests(normalizeRunRequestsInput(request.input), deps.runsPath);
    return {
      ok: true,
      command,
      exitCode: 0,
      text: formatHostRunRequests(requests),
      json: { requests }
    };
  }
  if (command === "run-request") {
    const runRequest = await getHostRunRequest(normalizeRunRequestInput(request.input), deps.runsPath);
    if (!runRequest) {
      return {
        ok: false,
        command,
        exitCode: 66,
        text: "host run request not found",
        error: "host run request not found"
      };
    }
    return {
      ok: true,
      command,
      exitCode: 0,
      text: formatHostRunRequestSummary(runRequest),
      json: { request: runRequest }
    };
  }
  if (command === "update-run") {
    const result = await updateHostRunRequest(normalizeUpdateRunInput(request.input), {
      path: deps.runsPath,
      now: deps.now
    });
    await syncRunRequestHeartbeat(result.request, deps.now);
    await syncRunRequestMeta(result.request, deps.now);
    await syncRunRequestLoopEvent(result.request, deps.now);
    return {
      ok: true,
      command,
      exitCode: 0,
      text: result.summary,
      json: result
    };
  }
  if (command === "cancel-run") {
    const result = await updateHostRunRequest(normalizeCancelRunInput(request.input), {
      path: deps.runsPath,
      now: deps.now
    });
    await syncRunRequestHeartbeat(result.request, deps.now);
    await syncRunRequestMeta(result.request, deps.now);
    await syncRunRequestLoopEvent(result.request, deps.now);
    return {
      ok: true,
      command,
      exitCode: 0,
      text: result.summary,
      json: result
    };
  }
  if (command === "execute-run") {
    const result = await executeNextHostRunRequest(normalizeExecuteRunInput(request.input), deps);
    return {
      ok: result.request ? result.request.status === "completed" : true,
      command,
      exitCode: result.request && result.request.status !== "completed" ? 1 : 0,
      text: formatHostRunExecuteResult(result),
      json: result
    };
  }
  if (command === "task-create") {
    const task = await createHostTask(normalizeTaskCreateInput(request.input), deps.now);
    return {
      ok: true,
      command,
      exitCode: 0,
      text: formatHostTasks([task]),
      json: { task }
    };
  }
  if (command === "task-list") {
    const tasks = await listHostTasks(normalizeTaskListInput(request.input));
    return {
      ok: true,
      command,
      exitCode: 0,
      text: formatHostTasks(tasks),
      json: { tasks }
    };
  }
  if (command === "task-update") {
    const task = await updateHostTask(normalizeTaskUpdateInput(request.input), deps.now);
    return {
      ok: true,
      command,
      exitCode: 0,
      text: formatHostTasks([task]),
      json: { task }
    };
  }
  if (command === "agenda") {
    const agenda = await buildHostAgenda(normalizeAgendaInput(request.input));
    return {
      ok: true,
      command,
      exitCode: 0,
      text: formatHostAgenda(agenda),
      json: agenda
    };
  }
  if (command === "capsule-create") {
    const capsule = await createHostCapsule(normalizeCapsuleCreateInput(request.input), deps.now);
    return {
      ok: true,
      command,
      exitCode: 0,
      text: formatHostCapsules([capsule]),
      json: { capsule }
    };
  }
  if (command === "capsule-list") {
    const capsules = await listHostCapsules(normalizeCapsuleListInput(request.input));
    return {
      ok: true,
      command,
      exitCode: 0,
      text: formatHostCapsules(capsules),
      json: { capsules }
    };
  }
  if (command === "capsule-update") {
    const capsule = await updateHostCapsule(normalizeCapsuleUpdateInput(request.input), deps.now);
    return {
      ok: true,
      command,
      exitCode: 0,
      text: formatHostCapsules([capsule]),
      json: { capsule }
    };
  }
  if (command === "workflow-create") {
    const card = await createHostWorkflowCard(applyCapabilityOwner(normalizeWorkflowCreateInput(request.input), deps), deps.now);
    return {
      ok: true,
      command,
      exitCode: 0,
      text: formatHostWorkflowCards([card]),
      json: { card }
    };
  }
  if (command === "workflow-list") {
    const cards = await listHostWorkflowCards(normalizeWorkflowListInput(request.input));
    return {
      ok: true,
      command,
      exitCode: 0,
      text: formatHostWorkflowCards(cards),
      json: { cards }
    };
  }
  if (command === "workflow-update") {
    const card = await updateHostWorkflowCard(normalizeWorkflowUpdateInput(request.input), deps.now);
    const handoffs = await runAutoHandoff(card, request.input, deps);
    return {
      ok: true,
      command,
      exitCode: 0,
      text: handoffs.length ? `${formatHostWorkflowCards([card])}\n${formatHandoffActions(handoffs)}` : formatHostWorkflowCards([card]),
      json: handoffs.length ? { card, handoffs } : { card }
    };
  }
  if (command === "initiative-create" || command === "handoff-create" || command === "review-create" || command === "decision-create" || command === "artifact-create") {
    const card = await createHostWorkflowCard(normalizeKindedWorkflowCreateInput(command, request.input), deps.now);
    return {
      ok: true,
      command,
      exitCode: 0,
      text: formatHostWorkflowCards([card]),
      json: { card }
    };
  }
  if (command === "feedback-record") {
    const feedback = await recordHostFeedback(normalizeFeedbackRecordInput(request.input), deps.now);
    return {
      ok: true,
      command,
      exitCode: 0,
      text: formatHostFeedback([feedback]),
      json: { feedback }
    };
  }
  if (command === "feedback-list") {
    const feedback = await listHostFeedback(normalizeFeedbackListInput(request.input));
    return {
      ok: true,
      command,
      exitCode: 0,
      text: formatHostFeedback(feedback),
      json: { feedback }
    };
  }
  if (command === "feedback-summary") {
    const summary = await summarizeHostFeedback(normalizeFeedbackListInput(request.input));
    return {
      ok: true,
      command,
      exitCode: 0,
      text: formatHostFeedbackSummary(summary),
      json: summary
    };
  }
  if (command === "cron-check") {
    const result = await runHostCronCheck(normalizeCronCheckInput(request.input), deps.now);
    return {
      ok: true,
      command,
      exitCode: 0,
      text: formatHostCronCheck(result),
      json: result
    };
  }
  if (command === "emit-run-event") {
    const result = await emitHostRunEvent(await normalizeEmitRunEventInput(request.input, deps.runsPath), deps.now);
    return {
      ok: true,
      command,
      exitCode: 0,
      text: `host run event emitted: ${result.file}\n${formatEmittedHostRunEvent(result.event)}`,
      json: result
    };
  }
  if (command === "watch-run") {
    const result = await readHostLoopEvents(await normalizeLoopEventsInput(request.input, deps.runsPath));
    return {
      ok: true,
      command,
      exitCode: 0,
      text: formatHostLoopEvents(result),
      json: result
    };
  }
  if (command === "run-results") {
    const result = await readHostLoopResults(await normalizeLoopResultsInput(request.input, deps.runsPath));
    return {
      ok: true,
      command,
      exitCode: 0,
      text: result.text ?? "",
      json: result
    };
  }
  if (command === "run-heartbeat") {
    const result = await readHostRunHeartbeat(await normalizeRunHeartbeatInput(request.input, deps.runsPath));
    return {
      ok: result.exists && !!result.heartbeat,
      command,
      exitCode: result.exists && result.heartbeat ? 0 : 66,
      text: formatHostRunHeartbeat(result),
      json: result,
      error: result.exists && result.heartbeat ? undefined : "host run heartbeat not found"
    };
  }
  if (command === "run-meta") {
    const result = await readHostRunMeta(await normalizeRunMetaInput(request.input, deps.runsPath));
    return {
      ok: result.exists && !!result.meta,
      command,
      exitCode: result.exists && result.meta ? 0 : 66,
      text: formatHostRunMeta(result),
      json: result,
      error: result.exists && result.meta ? undefined : "host run meta not found"
    };
  }
  if (command === "plan-export") {
    const plan = await planHostExport(normalizeExportInput(request.input));
    return {
      ok: true,
      command,
      exitCode: 0,
      text: plan.summary,
      json: plan
    };
  }
  if (command === "export") {
    const result = await exportHostArtifacts(normalizeExportInput(request.input));
    return {
      ok: true,
      command,
      exitCode: 0,
      text: `${result.summary}\nwritten files:\n${result.writtenFiles.map((file) => `  - ${file}`).join("\n") || "  (none)"}`,
      json: result
    };
  }
  if (command === "compact-ledger") {
    const result = await compactHostLedger(normalizeCompactLedgerInput(request.input));
    return {
      ok: true,
      command,
      exitCode: 0,
      text: formatHostLedgerCompact(result),
      json: result
    };
  }
  if (command === "doctor") {
    const results = await (deps.collectDoctorResults ?? collectDoctorResults)();
    const exitCode = doctorExitCode(results);
    return {
      ok: exitCode === 0,
      command,
      exitCode,
      text: formatDoctorReport(results),
      json: { results, exitCode }
    };
  }

  const state = await readState();
  const snapshot = buildHostStatusSnapshot(state, tokenBudget(), usagePricing());
  if (command === "status") {
    return {
      ok: snapshot.ok,
      command,
      exitCode: snapshot.ok ? 0 : 1,
      text: formatHostStatusSnapshot(snapshot),
      json: snapshot
    };
  }
  if (command === "usage") {
    const summary = summarizeAgentUsage(state?.agents ?? [], tokenBudget(), usagePricing());
    return {
      ok: true,
      command,
      exitCode: 0,
      text: formatUsageSummary(summary),
      json: {
        ...summary,
        runtimeData: buildUsageRuntimeData(state, { budget: tokenBudget(), pricingRules: usagePricing() })
      }
    };
  }
  if (command === "expenses") {
    const summary = summarizeAgentUsage(state?.agents ?? [], tokenBudget(), usagePricing());
    const expenses = listUsageExpenses(summary);
    return {
      ok: true,
      command,
      exitCode: 0,
      text: formatUsageExpenses(expenses),
      json: {
        expenses,
        usage: summary
      }
    };
  }

  return {
    ok: true,
    command,
    exitCode: 0,
    text: formatEvents(snapshot.events),
    json: { events: snapshot.events }
  };
}

function isDestructiveHostCommand(command: string): boolean {
  return COMMANDS.some((entry) => entry.name === command && entry.destructive);
}

function ledgerPathInput(value: unknown): { outputDir?: string; workflowFile?: string } {
  if (!value || typeof value !== "object") return {};
  const record = value as { outputDir?: unknown; workflowFile?: unknown };
  return {
    outputDir: typeof record.outputDir === "string" ? record.outputDir : undefined,
    workflowFile: typeof record.workflowFile === "string" ? record.workflowFile : undefined
  };
}

function normalizePolicyInput(value: unknown): { command: string; confirmed?: unknown; confirmation?: unknown } {
  if (!value || typeof value !== "object") throw new Error("policy input must include a command");
  const input = value as { command?: unknown; confirmed?: unknown; confirmation?: unknown };
  if (typeof input.command !== "string" || !input.command.trim()) throw new Error("policy input must include a command");
  return {
    command: input.command,
    confirmed: input.confirmed,
    confirmation: input.confirmation
  };
}

function normalizeTimelineInput(value: unknown): { limit?: number } {
  if (!value) return {};
  if (typeof value !== "object") throw new Error("timeline input must be an object");
  const raw = (value as { limit?: unknown }).limit;
  if (raw === undefined) return {};
  const limit = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(limit) || limit < 1) throw new Error("timeline limit must be a positive integer");
  return { limit };
}

function normalizeRunInput(value: unknown): HostRunSpecInput {
  if (value && typeof value === "object") return value as HostRunSpecInput;
  if (typeof value === "string") return { goal: value };
  throw new Error("plan-run input must include a goal");
}

function normalizeSubmitRunInput(value: unknown): HostRunSubmitInput {
  if (value && typeof value === "object") return value as HostRunSubmitInput;
  if (typeof value === "string") return { goal: value };
  throw new Error("submit-run input must include a goal");
}

function withExecutorActorRole(input: HostRunSubmitInput, actorRole?: string): HostRunSubmitInput {
  if (!input.executor || input.executor.actorRole || !actorRole) return input;
  return {
    ...input,
    executor: {
      ...input.executor,
      actorRole
    }
  };
}

function normalizeRunLayoutInput(value: unknown): HostRunLayoutInput {
  if (value && typeof value === "object") return value as HostRunLayoutInput;
  if (typeof value === "string") return { goal: value };
  throw new Error("prepare-run-layout input must include a goal");
}

function normalizeRunRequestsInput(value: unknown): HostRunListInput {
  if (!value) return {};
  if (typeof value !== "object") throw new Error("run-requests input must be an object");
  return value as HostRunListInput;
}

function normalizeRunRequestInput(value: unknown): HostRunGetInput {
  if (!value || typeof value !== "object") throw new Error("run-request input must include an id");
  return value as HostRunGetInput;
}

function normalizeUpdateRunInput(value: unknown): HostRunUpdateInput {
  if (!value || typeof value !== "object") throw new Error("update-run input must include id and status");
  return value as HostRunUpdateInput;
}

function normalizeCancelRunInput(value: unknown): HostRunUpdateInput {
  if (!value || typeof value !== "object") throw new Error("cancel-run input must include an id");
  const input = value as { id?: unknown; detail?: unknown };
  return {
    id: input.id,
    status: "cancelled",
    detail: input.detail
  } as HostRunUpdateInput;
}

function normalizeExecuteRunInput(value: unknown): HostRunExecuteInput {
  if (!value) return {};
  if (typeof value !== "object") throw new Error("execute-run input must be an object");
  return value as HostRunExecuteInput;
}

function normalizeTaskCreateInput(value: unknown): HostTaskCreateInput {
  if (!value || typeof value !== "object") throw new Error("task-create input must include a title");
  return value as HostTaskCreateInput;
}

function normalizeTaskListInput(value: unknown): HostTaskListInput {
  if (!value) return {};
  if (typeof value !== "object") throw new Error("task-list input must be an object");
  return value as HostTaskListInput;
}

function normalizeTaskUpdateInput(value: unknown): HostTaskUpdateInput {
  if (!value || typeof value !== "object") throw new Error("task-update input must include an id");
  return value as HostTaskUpdateInput;
}

function normalizeAgendaInput(value: unknown): HostAgendaInput {
  if (!value) return {};
  if (typeof value !== "object") throw new Error("agenda input must be an object");
  return value as HostAgendaInput;
}

function normalizeCapsuleCreateInput(value: unknown): HostCapsuleCreateInput {
  if (!value || typeof value !== "object") throw new Error("capsule-create input must include a goal");
  return value as HostCapsuleCreateInput;
}

function normalizeCapsuleListInput(value: unknown): HostCapsuleListInput {
  if (!value) return {};
  if (typeof value !== "object") throw new Error("capsule-list input must be an object");
  return value as HostCapsuleListInput;
}

function normalizeCapsuleUpdateInput(value: unknown): HostCapsuleUpdateInput {
  if (!value || typeof value !== "object") throw new Error("capsule-update input must include an id");
  return value as HostCapsuleUpdateInput;
}

function normalizeWorkflowCreateInput(value: unknown): HostWorkflowCardCreateInput {
  if (!value || typeof value !== "object") throw new Error("workflow-create input must include kind and title");
  return value as HostWorkflowCardCreateInput;
}

function normalizeWorkflowListInput(value: unknown): HostWorkflowCardListInput {
  if (!value) return {};
  if (typeof value !== "object") throw new Error("workflow-list input must be an object");
  return value as HostWorkflowCardListInput;
}

function normalizeWorkflowUpdateInput(value: unknown): HostWorkflowCardUpdateInput {
  if (!value || typeof value !== "object") throw new Error("workflow-update input must include an id");
  return value as HostWorkflowCardUpdateInput;
}

function normalizeCompactLedgerInput(value: unknown): HostLedgerPathInput {
  if (!value) return {};
  if (typeof value !== "object") throw new Error("compact-ledger input must be an object");
  return value as HostLedgerPathInput;
}

/**
 * Capability-first owner selection: when a workflow card is created without an explicit ownerRole but
 * carries `requiredCapabilities`, route it to the best-matching team role per the routing policy.
 */
function applyCapabilityOwner(input: HostWorkflowCardCreateInput, deps: HostCommandRunnerDeps): HostWorkflowCardCreateInput {
  if (cleanInputString(input.ownerRole)) return input;
  const capabilities = (input as { requiredCapabilities?: unknown }).requiredCapabilities;
  if (!Array.isArray(capabilities)) return input;
  const required = capabilities.filter((entry): entry is string => typeof entry === "string");
  if (required.length === 0) return input;
  const owner = selectOwnerRole(resolveTeamSpec({ teamSpec: deps.teamSpec }), required);
  return owner ? { ...input, ownerRole: owner } : input;
}

export interface HostHandoffResult {
  reason: HandoffAction["reason"];
  card: HostWorkflowCard;
}

/**
 * Execute the team routing policy when a workflow card reaches `done`: materialize the follow-up
 * review/decision/handoff cards the policy requires. Opt out per call with `{ handoff: false }` or per
 * runner with `deps.autoHandoff === false`.
 */
async function runAutoHandoff(card: HostWorkflowCard, rawInput: unknown, deps: HostCommandRunnerDeps): Promise<HostHandoffResult[]> {
  if (deps.autoHandoff === false || handoffDisabled(rawInput) || card.status !== "done") return [];
  const source = card.sourceId ? await findWorkflowCard(card.sourceId, rawInput) : null;
  const actions = planHandoff({
    ...card,
    sourceOwnerRole: source?.ownerRole
  }, resolveTeamSpec({ teamSpec: deps.teamSpec }));
  if (actions.length === 0) return [];
  const paths = ledgerPathInput(rawInput);
  const existing = await listHostWorkflowCards(paths);
  const created: HostHandoffResult[] = [];
  for (const action of actions) {
    const reason = autoHandoffReason(action, card);
    if (existing.some((entry) => entry.sourceId === card.id && entry.metadata?.autoHandoff === true && entry.metadata?.reason === reason)) continue;
    const next = await createHostWorkflowCard({
      ...paths,
      kind: action.card.kind,
      title: action.card.title,
      status: action.card.status as HostWorkflowCardCreateInput["status"],
      ownerRole: action.card.ownerRole,
      reviewerRole: action.card.reviewerRole,
      targetRole: action.card.targetRole,
      dependsOn: action.card.dependsOn,
      sourceId: action.card.sourceId,
      decisionBy: action.card.decisionBy,
      detail: action.card.detail,
      handoffPolicy: action.card.handoffPolicy,
      metadata: { autoHandoff: true, reason, sourceCard: card.id, reviewedCard: card.kind === "review" ? card.sourceId : undefined }
    }, deps.now);
    created.push({ reason: action.reason, card: next });
  }
  return created;
}

function handoffDisabled(input: unknown): boolean {
  return Boolean(input && typeof input === "object" && (input as { handoff?: unknown }).handoff === false);
}

async function findWorkflowCard(id: string, rawInput: unknown): Promise<HostWorkflowCard | null> {
  return (await listHostWorkflowCards(ledgerPathInput(rawInput))).find((card) => card.id === id) ?? null;
}

function autoHandoffReason(action: HandoffAction, sourceCard: HostWorkflowCard): string {
  return sourceCard.kind === "review" && normalizeReviewVerdict(sourceCard.result) === "changes_requested"
    ? "changes-requested"
    : action.reason;
}

function formatHandoffActions(handoffs: HostHandoffResult[]): string {
  return handoffs
    .map(({ reason, card }) => `auto-handoff (${reason}) -> ${card.id} ${card.kind} ${card.status}${card.ownerRole ? ` ownerRole=${card.ownerRole}` : ""}: ${card.title}`)
    .join("\n");
}

function normalizeKindedWorkflowCreateInput(command: HostCommandName, value: unknown): HostWorkflowCardCreateInput {
  if (!value || typeof value !== "object") throw new Error(`${command} input must include a title`);
  const kind = command.replace(/-create$/, "");
  if (kind !== "initiative" && kind !== "handoff" && kind !== "review" && kind !== "decision" && kind !== "artifact") {
    throw new Error(`unsupported workflow create command: ${command}`);
  }
  return {
    ...(value as Record<string, unknown>),
    kind,
    status: kind === "decision" ? ((value as { status?: unknown }).status ?? "waiting_human") : (value as { status?: unknown }).status
  } as HostWorkflowCardCreateInput;
}

function normalizeFeedbackRecordInput(value: unknown): HostFeedbackRecordInput {
  if (!value || typeof value !== "object") throw new Error("feedback-record input must be an object");
  return value as HostFeedbackRecordInput;
}

function normalizeFeedbackListInput(value: unknown): HostFeedbackListInput {
  if (!value) return {};
  if (typeof value !== "object") throw new Error("feedback input must be an object");
  return value as HostFeedbackListInput;
}

interface HostCronScheduleInput {
  id?: string;
  cron: string;
  type?: string;
  agent?: string;
  message?: string;
  payload?: unknown;
}

interface HostCronCheckInput {
  outputDir?: string;
  file?: string;
  runId?: string;
  now?: string;
  schedules: HostCronScheduleInput[];
}

interface HostCronCheckResult {
  now: string;
  checked: number;
  matched: number;
  emitted: Array<{ id?: string; type: string; file: string; event: HostLoopEvent }>;
}

function normalizeCronCheckInput(value: unknown): HostCronCheckInput {
  if (!value || typeof value !== "object") throw new Error("cron-check input must include schedules");
  const input = value as { schedules?: unknown; outputDir?: unknown; file?: unknown; runId?: unknown; now?: unknown };
  if (!Array.isArray(input.schedules)) throw new Error("cron-check schedules must be an array");
  return {
    outputDir: cleanInputString(input.outputDir),
    file: cleanInputString(input.file),
    runId: cleanInputString(input.runId),
    now: cleanInputString(input.now),
    schedules: input.schedules.map((entry) => {
      if (!entry || typeof entry !== "object") throw new Error("cron-check schedule entries must be objects");
      const schedule = entry as { id?: unknown; cron?: unknown; type?: unknown; agent?: unknown; message?: unknown; payload?: unknown };
      const cron = cleanInputString(schedule.cron);
      if (!cron) throw new Error("cron-check schedule cron is required");
      return {
        id: cleanInputString(schedule.id),
        cron,
        type: cleanInputString(schedule.type),
        agent: cleanInputString(schedule.agent),
        message: cleanInputString(schedule.message),
        payload: schedule.payload
      };
    })
  };
}

async function runHostCronCheck(input: HostCronCheckInput, now?: () => Date): Promise<HostCronCheckResult> {
  if (!input.file && !input.outputDir) throw new Error("cron-check requires a file or outputDir");
  const date = input.now ? new Date(input.now) : (now ?? (() => new Date()))();
  if (Number.isNaN(date.getTime())) throw new Error("cron-check now must be a valid date");
  const emitted: HostCronCheckResult["emitted"] = [];
  for (const schedule of input.schedules) {
    if (!cronMatches(schedule.cron, date)) continue;
    const event: HostLoopEvent = dropUndefined({
      type: schedule.type ?? "cron.tick",
      runId: input.runId,
      timestamp: date.toISOString(),
      agent: schedule.agent,
      message: schedule.message,
      payload: schedule.payload,
      source: "cron-check"
    });
    const file = await appendHostLoopEvent({
      file: input.file,
      outputDir: input.outputDir,
      event
    });
    emitted.push({ id: schedule.id, type: event.type ?? "cron.tick", file, event });
  }
  return {
    now: date.toISOString(),
    checked: input.schedules.length,
    matched: emitted.length,
    emitted
  };
}

function formatHostCronCheck(result: HostCronCheckResult): string {
  const lines = [`cron-check: checked=${result.checked} matched=${result.matched} now=${result.now}`];
  for (const entry of result.emitted) lines.push(`  - ${entry.id ?? entry.type}: ${entry.file}`);
  return lines.join("\n");
}

async function normalizeLoopEventsInput(value: unknown, runsPath?: string): Promise<HostLoopEventsInput> {
  if (!value) return {};
  if (typeof value !== "object") throw new Error("watch-run input must be an object");
  const input = value as HostLoopEventsInput & { id?: unknown };
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : undefined;
  if (!input.file && !input.outputDir && id) {
    const request = await getHostRunRequest({ id }, runsPath);
    const outputDir = request?.spec.options?.outputDir;
    return {
      ...input,
      outputDir,
      runId: input.runId ?? id
    };
  }
  return input;
}

interface HostRunEventEmitInput {
  id?: string;
  file?: string;
  outputDir?: string;
  event?: HostLoopEvent;
  type?: string;
  agent?: string;
  loop?: number;
  classification?: string;
  detail?: string;
  message?: string;
  payload?: unknown;
}

async function normalizeEmitRunEventInput(value: unknown, runsPath?: string): Promise<Required<Pick<HostRunEventEmitInput, "event">> & HostRunEventEmitInput> {
  if (!value || typeof value !== "object") throw new Error("emit-run-event input must include an event object or type");
  const input = value as HostRunEventEmitInput;
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : undefined;
  let outputDir = cleanInputString(input.outputDir);
  if (!input.file && !outputDir && id) {
    const request = await getHostRunRequest({ id }, runsPath);
    outputDir = request?.spec.options?.outputDir;
  }
  const eventInput = input.event && typeof input.event === "object" ? input.event : {};
  const type = cleanInputString((eventInput as { type?: unknown }).type) ?? cleanInputString(input.type);
  if (!type) throw new Error("emit-run-event type is required");
  return {
    ...input,
    id,
    outputDir,
    event: {
      ...eventInput,
      type,
      runId: cleanInputString((eventInput as { runId?: unknown }).runId) ?? id,
      loop: numberInput((eventInput as { loop?: unknown }).loop) ?? numberInput(input.loop),
      agent: cleanInputString((eventInput as { agent?: unknown }).agent) ?? cleanInputString(input.agent),
      classification: cleanInputString((eventInput as { classification?: unknown }).classification) ?? cleanInputString(input.classification),
      detail: cleanInputString((eventInput as { detail?: unknown }).detail) ?? cleanInputString(input.detail),
      message: cleanInputString((eventInput as { message?: unknown }).message) ?? cleanInputString(input.message),
      payload: (eventInput as { payload?: unknown }).payload ?? input.payload
    }
  };
}

async function emitHostRunEvent(input: HostRunEventEmitInput & { event: HostLoopEvent }, now?: () => Date): Promise<{ file: string; event: HostLoopEvent }> {
  if (!input.file && !input.outputDir) throw new Error("emit-run-event requires a file, outputDir, or run id with outputDir");
  const event = dropUndefined({
    ...input.event,
    runId: typeof input.event.runId === "string" && input.event.runId.trim() ? input.event.runId.trim() : input.id,
    timestamp: typeof input.event.timestamp === "string" && input.event.timestamp.trim() ? input.event.timestamp.trim() : (now ?? (() => new Date()))().toISOString(),
    source: typeof input.event.source === "string" && input.event.source.trim() ? input.event.source.trim() : "host-app"
  });
  const file = await appendHostLoopEvent({
    file: input.file,
    outputDir: input.outputDir,
    event
  });
  return { file, event };
}

function formatEmittedHostRunEvent(event: HostLoopEvent): string {
  return `${event.timestamp ?? "no-time"} ${event.type ?? "unknown"} run=${event.runId ?? "?"}`;
}

async function normalizeLoopResultsInput(value: unknown, runsPath?: string): Promise<HostLoopResultsInput> {
  if (!value) return {};
  if (typeof value !== "object") throw new Error("run-results input must be an object");
  const input = value as HostLoopResultsInput & { id?: unknown };
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : undefined;
  if (!input.file && !input.outputDir && !input.resultsFile && id) {
    const request = await getHostRunRequest({ id }, runsPath);
    const outputDir = request?.spec.options?.outputDir;
    return {
      ...input,
      outputDir
    };
  }
  return input;
}

async function normalizeRunHeartbeatInput(value: unknown, runsPath?: string): Promise<HostRunHeartbeatReadInput> {
  if (!value) return {};
  if (typeof value !== "object") throw new Error("run-heartbeat input must be an object");
  const input = value as HostRunHeartbeatReadInput & { id?: unknown };
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : undefined;
  if (!input.file && !input.outputDir && id) {
    const request = await getHostRunRequest({ id }, runsPath);
    const outputDir = request?.spec.options?.outputDir;
    return {
      ...input,
      outputDir
    };
  }
  return input;
}

async function normalizeRunMetaInput(value: unknown, runsPath?: string): Promise<HostRunMetaReadInput> {
  if (!value) return {};
  if (typeof value !== "object") throw new Error("run-meta input must be an object");
  const input = value as HostRunMetaReadInput & { id?: unknown };
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : undefined;
  if (!input.file && !input.outputDir && id) {
    const request = await getHostRunRequest({ id }, runsPath);
    const outputDir = request?.spec.options?.outputDir;
    return {
      ...input,
      outputDir
    };
  }
  return input;
}

async function syncRunRequestHeartbeat(request: HostRunRequest, now?: () => Date): Promise<void> {
  const outputDir = request.spec.options?.outputDir;
  if (!outputDir || request.status === "pending") return;
  await writeHostRunHeartbeat({
    path: hostRunHeartbeatPathForOutputDir(outputDir),
    runId: request.id,
    status: request.status,
    outputDir,
    pid: process.pid,
    detail: request.detail,
    command: request.result?.command,
    exitCode: request.result?.exitCode,
    loopCount: request.status === "running" ? 0 : 1,
    now
  });
}

async function syncRunRequestMeta(request: HostRunRequest, now?: () => Date): Promise<void> {
  const outputDir = request.spec.options?.outputDir;
  if (!outputDir || request.status === "pending") return;
  await updateHostRunMeta({
    file: hostRunMetaPathForOutputDir(outputDir),
    runId: request.id,
    status: request.status,
    actualLoops: request.status === "running" ? 0 : 1,
    detail: request.detail,
    command: request.result?.command,
    exitCode: request.result?.exitCode,
    now
  });
}

async function syncRunRequestLoopEvent(request: HostRunRequest, now?: () => Date): Promise<void> {
  const outputDir = request.spec.options?.outputDir;
  if (!outputDir || request.status === "pending") return;
  await appendHostLoopEvent({
    outputDir,
    event: {
      type: "run.status",
      runId: request.id,
      timestamp: (now ?? (() => new Date()))().toISOString(),
      status: request.status,
      detail: request.detail,
      command: request.result?.command,
      exitCode: request.result?.exitCode,
      loop: request.status === "running" ? 0 : 1,
      source: "update-run"
    }
  });
}

function normalizeExportInput(value: unknown): HostExportInput {
  if (!value) return {};
  if (value && typeof value === "object") return value as HostExportInput;
  throw new Error("export input must be an object");
}

function cleanInputString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberInput(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function dropUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function normalizeAvailableEngines(value: unknown): Array<"claude" | "codex"> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is "claude" | "codex" => entry === "claude" || entry === "codex");
}
