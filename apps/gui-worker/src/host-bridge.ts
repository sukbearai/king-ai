import { createHostSdk } from "@suwujs/king-ai/host-sdk";
import { mergeWorkflowCards, workflowCardFromHostRecord, type WorkflowCard } from "@suwujs/king-ai/workflow-core";
import { listGuiWorkflowCards, type GuiKanbanCardLike, type GuiTaskLike } from "./workflow-state.js";

export type HostBridgeBindings = {
  KING_AI_HOST_URL?: string;
  KING_AI_HOST_OUTPUT_DIR?: string;
};

export type HostDecisionCard = WorkflowCard & {
  decisionBy?: string;
  detail?: string;
};

export type HostDecisionsResult = {
  configured: boolean;
  cards: HostDecisionCard[];
  error?: string;
};

export type HostWorkflowSnapshot = {
  configured: boolean;
  hostCards: HostDecisionCard[];
  workflowCards: WorkflowCard[];
  error?: string;
};

type HostCommandResult<T = unknown> = {
  ok?: boolean;
  text?: string;
  json?: T;
  error?: string;
};

function hostBridgeOutputDir(env: HostBridgeBindings): Record<string, string> {
  const dir = typeof env.KING_AI_HOST_OUTPUT_DIR === "string" ? env.KING_AI_HOST_OUTPUT_DIR.trim() : "";
  return dir ? { outputDir: dir } : {};
}

function localHostBridgeUrl(request: Request): string {
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"
    ? "http://127.0.0.1:8799"
    : "";
}

export function hostBridgeSdk(env: HostBridgeBindings, request: Request) {
  const configuredUrl = typeof env.KING_AI_HOST_URL === "string" ? env.KING_AI_HOST_URL.trim() : "";
  const baseUrl = configuredUrl || localHostBridgeUrl(request);
  if (!baseUrl) return null;
  return createHostSdk({ baseUrl, fetch: (input, init) => fetch(input as RequestInfo, init) });
}

function normalizeHostBridgeCards(value: unknown): HostDecisionCard[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && typeof row.id === "string",
    )
    .map((row) => {
      const decisionBy = typeof row.decisionBy === "string" ? row.decisionBy : undefined;
      const detail = typeof row.detail === "string" ? row.detail : undefined;
      return {
        ...workflowCardFromHostRecord({
          id: String(row.id),
          kind: typeof row.kind === "string" ? row.kind : undefined,
          title: typeof row.title === "string" ? row.title : undefined,
          status: typeof row.status === "string" ? row.status : undefined,
          ownerRole: typeof row.ownerRole === "string" ? row.ownerRole : undefined,
          reviewerRole: typeof row.reviewerRole === "string" ? row.reviewerRole : undefined,
          assignee: typeof row.assignee === "string" ? row.assignee : undefined,
          decisionBy,
          detail,
          sourceId: typeof row.sourceId === "string" ? row.sourceId : undefined,
          dependsOn: Array.isArray(row.dependsOn)
            ? row.dependsOn.filter((entry): entry is string => typeof entry === "string")
            : undefined,
          acceptance: Array.isArray(row.acceptance)
            ? row.acceptance.filter((entry): entry is string => typeof entry === "string")
            : undefined,
          result: typeof row.result === "string" ? row.result : undefined,
        }),
        decisionBy,
        detail,
      };
    });
}

export async function fetchHostWorkflowSnapshot(
  env: HostBridgeBindings,
  request: Request,
  gui: { tasks: GuiTaskLike[]; kanban: GuiKanbanCardLike[] },
): Promise<HostWorkflowSnapshot> {
  const host = await fetchHostDecisions(env, request);
  const guiCards = listGuiWorkflowCards({ tasks: gui.tasks, kanban: gui.kanban });
  return {
    configured: host.configured,
    hostCards: host.cards,
    workflowCards: mergeWorkflowCards(guiCards, host.cards),
    error: host.error,
  };
}

export async function fetchHostDecisions(env: HostBridgeBindings, request: Request): Promise<HostDecisionsResult> {
  const sdk = hostBridgeSdk(env, request);
  if (!sdk) return { configured: false, cards: [] };
  try {
    const result = await sdk.runCommand<{ cards?: unknown }>({
      command: "workflow-list",
      actorRole: "reviewer",
      input: { kind: "decision", status: "waiting_human", limit: 50, ...hostBridgeOutputDir(env) },
    });
    const cards = normalizeHostBridgeCards(result.json?.cards);
    return { configured: true, cards, error: result.ok ? undefined : result.error || "host command failed" };
  } catch (err) {
    return { configured: true, cards: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function resolveHostDecision(
  env: HostBridgeBindings,
  request: Request,
  id: string,
  decision: "approve" | "deny",
): Promise<{ ok: boolean; card?: WorkflowCard; error?: string }> {
  const sdk = hostBridgeSdk(env, request);
  if (!sdk) return { ok: false, error: "host bridge not configured" };
  try {
    const result = await sdk.runCommand<{ card?: unknown }>({
      command: "workflow-update",
      actorRole: "reviewer",
      input: {
        id,
        status: decision === "approve" ? "done" : "cancelled",
        result: decision === "approve" ? "approved from gui" : "denied from gui",
        humanApproved: decision === "approve" ? true : undefined,
        approvedBy: decision === "approve" ? "gui-human" : undefined,
        ...hostBridgeOutputDir(env),
      },
    });
    const card =
      result.json?.card &&
      typeof result.json.card === "object" &&
      typeof (result.json.card as { id?: unknown }).id === "string"
        ? workflowCardFromHostRecord(result.json.card as { id: string })
        : undefined;
    return { ok: result.ok, card, error: result.ok ? undefined : result.error || result.text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runHostRemoteCommand<T = unknown>(
  env: HostBridgeBindings,
  request: Request,
  command: string,
  input?: unknown,
): Promise<{ configured: boolean; result?: HostCommandResult<T>; error?: string }> {
  const sdk = hostBridgeSdk(env, request);
  if (!sdk) return { configured: false, error: "host bridge not configured" };
  try {
    const result = await sdk.runCommand<T>({ command, input });
    return { configured: true, result };
  } catch (err) {
    return { configured: true, error: err instanceof Error ? err.message : String(err) };
  }
}
