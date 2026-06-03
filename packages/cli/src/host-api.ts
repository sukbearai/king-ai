import { formatRunningStateSnapshot } from "./service.js";
import type { RunningEvent, RunningState } from "./service.js";
import { summarizeAgentUsage } from "./usage.js";
import type { UsagePricingRule, UsageSummary } from "./usage.js";
import { worktreePlansFromRunningState } from "./service.js";
import type { WorktreePlan } from "./worktree.js";
import type { RemediationAdvice } from "./remediation.js";
import type { AgentConfigWarning } from "./agent-config-validation.js";

export interface HostAgentStatus {
  id: string;
  name: string;
  engine: string;
  lifecycle?: string;
  status?: string;
  model?: string;
  workspaceRoot?: string;
  sharedSkillSnapshotId?: string;
  hostHomeEntries?: Array<{
    name: string;
    linked: boolean;
    reason?: string;
  }>;
  remediation?: Pick<RemediationAdvice, "category" | "severity" | "summary" | "actions"> | null;
  configWarnings?: AgentConfigWarning[];
}

export interface HostStatusSnapshot {
  ok: boolean;
  version?: string;
  pid?: number;
  startedAt?: string;
  serverUrl?: string;
  computerId?: string;
  capabilities: {
    workspaces: string[];
  };
  agents: HostAgentStatus[];
  usage: UsageSummary;
  worktrees: WorktreePlan[];
  events: RunningEvent[];
  text: string;
}

export function buildHostStatusSnapshot(state: RunningState | null, budget?: number | null, pricingRules: UsagePricingRule[] = []): HostStatusSnapshot {
  return {
    ok: Boolean(state),
    version: state?.version,
    pid: state?.pid,
    startedAt: state?.startedAt,
    serverUrl: state?.serverUrl,
    computerId: state?.computerId,
    capabilities: {
      workspaces: state?.capabilities?.workspaces ?? []
    },
    agents: (state?.agents ?? []).map((agent) => ({
      id: agent.id,
      name: agent.name,
      engine: agent.engine,
      lifecycle: agent.lifecycle,
      status: agent.status,
      model: agent.model,
      workspaceRoot: agent.workspaceRoot,
      sharedSkillSnapshotId: agent.sharedSkillSnapshot?.id,
      hostHomeEntries: agent.hostHomeEntries?.map((entry) => ({
        name: entry.name,
        linked: entry.linked,
        reason: entry.reason
      })),
      remediation: agent.remediation
        ? {
            category: agent.remediation.category,
            severity: agent.remediation.severity,
            summary: agent.remediation.summary,
            actions: agent.remediation.actions
          }
        : null,
      configWarnings: agent.configWarnings ?? []
    })),
    usage: summarizeAgentUsage(state?.agents ?? [], budget, pricingRules),
    worktrees: worktreePlansFromRunningState(state),
    events: state?.events?.slice(-20) ?? [],
    text: formatRunningStateSnapshot(state)
  };
}

export function formatHostStatusSnapshot(snapshot: HostStatusSnapshot): string {
  if (!snapshot.ok) return "host status: daemon is not running or running.json is unavailable";
  const lines = [
    `host status: ${snapshot.version ?? "unknown"} pid=${snapshot.pid ?? "unknown"}`,
    snapshot.computerId || snapshot.serverUrl
      ? `paired: ${snapshot.computerId ?? "unknown"} @ ${snapshot.serverUrl ?? "unknown"}`
      : "paired: unknown",
    `agents=${snapshot.agents.length} workspaces=${snapshot.capabilities.workspaces.length} worktrees=${snapshot.worktrees.length}`,
    `usage: runs=${snapshot.usage.turns} failed=${snapshot.usage.failed} tokens=${snapshot.usage.totalTokens}`
  ];
  if (snapshot.text) lines.push(snapshot.text);
  return lines.join("\n");
}
