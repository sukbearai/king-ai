export type RuntimeMessagePriority = "normal" | "steer" | "urgent";
export type RuntimeMessageType = "message" | "decision" | "blocker" | "approval" | "system";
export type RuntimeRouteHint = "ignore" | "monitor" | "respond" | "steer";

export interface RuntimeMessageLike {
  id?: string;
  conversation_id?: string;
  conversation_title?: string;
  conversation_kind?: string;
  conversation_topic?: string;
  author_name?: string;
  author_kind?: string;
  kind?: string;
  body?: string;
  priority?: string;
  message_type?: string;
  to_agent_id?: string;
  created_at?: number;
}

export interface RoutedRuntimeMessage<T extends RuntimeMessageLike = RuntimeMessageLike> {
  row: T;
  score: number;
  priority: RuntimeMessagePriority;
  type: RuntimeMessageType;
  route: RuntimeRouteHint;
  reasons: string[];
}

function lower(value?: string): string {
  return (value ?? "").toLowerCase();
}

function isMentioned(row: RuntimeMessageLike, agentId: string): boolean {
  const body = row.body ?? "";
  return body.includes(`@${agentId}`);
}

export function normalizeMessageType(row: RuntimeMessageLike): RuntimeMessageType {
  const explicit = lower(row.message_type);
  if (explicit === "decision" || explicit === "blocker" || explicit === "approval" || explicit === "message")
    return explicit;
  if (explicit === "system") return "system";
  if (row.kind === "system" || row.author_kind === "system") return "system";
  const body = lower(row.body);
  if (/\bapproval required\b|\bapproval requested\b|\bapprove\b|\bdeny\b/.test(body)) return "approval";
  if (/\bblocked\b|\bblocker\b|\bstuck\b|\bwaiting on\b/.test(body)) return "blocker";
  if (/\bdecision\b|\bdecide\b|\bapproved\b|\brejected\b/.test(body)) return "decision";
  return "message";
}

export function normalizeMessagePriority(row: RuntimeMessageLike): RuntimeMessagePriority {
  const explicit = lower(row.priority);
  if (explicit === "urgent" || explicit === "steer") return explicit;
  const type = normalizeMessageType(row);
  if (type === "approval" || type === "blocker") return "urgent";
  if (type === "decision") return "steer";
  return "normal";
}

export function routeRuntimeMessage(row: RuntimeMessageLike, agentId: string): RoutedRuntimeMessage {
  const type = normalizeMessageType(row);
  const priority = normalizeMessagePriority(row);
  const reasons: string[] = [];
  let score = 0;

  if (row.to_agent_id === agentId) {
    score += 70;
    reasons.push("targeted");
  } else if (row.to_agent_id) {
    score -= 100;
    reasons.push("targeted elsewhere");
  }

  if (row.conversation_kind === "direct") {
    score += 45;
    reasons.push("direct");
  }
  if (row.author_kind === "human") {
    score += 30;
    reasons.push("human");
  }
  if (isMentioned(row, agentId)) {
    score += 35;
    reasons.push("mention");
  }

  if (priority === "urgent") {
    score += 60;
    reasons.push("urgent");
  } else if (priority === "steer") {
    score += 45;
    reasons.push("steer");
  }

  if (type === "approval") {
    score += 55;
    reasons.push("approval");
  } else if (type === "blocker") {
    score += 45;
    reasons.push("blocker");
  } else if (type === "decision") {
    score += 30;
    reasons.push("decision");
  } else if (type === "system") {
    score -= 15;
    reasons.push("system");
  }

  const route: RuntimeRouteHint =
    score < 0
      ? "ignore"
      : priority === "urgent" || priority === "steer" || row.conversation_kind === "direct" || isMentioned(row, agentId)
        ? "steer"
        : row.author_kind === "human"
          ? "respond"
          : "monitor";

  return { row, score, priority, type, route, reasons };
}

export function sortRuntimeMessages<T extends RuntimeMessageLike>(
  rows: T[],
  agentId: string,
): RoutedRuntimeMessage<T>[] {
  return rows
    .map((row) => routeRuntimeMessage(row, agentId) as RoutedRuntimeMessage<T>)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (a.row.created_at ?? 0) - (b.row.created_at ?? 0);
    });
}

export function messageRouteTag(routed: Pick<RoutedRuntimeMessage, "priority" | "type" | "route">): string {
  const type = routed.type === "message" ? "msg" : routed.type;
  return `${routed.route}/${routed.priority}/${type}`;
}

export function formatMessageRouteSummary<T extends RuntimeMessageLike>(rows: T[], agentId: string, max = 8): string {
  const routed = sortRuntimeMessages(rows, agentId).slice(0, max);
  if (routed.length === 0) return "";
  return routed
    .map((item) => {
      const id = item.row.id ?? "?";
      const who = item.row.author_name ?? "someone";
      const body = item.row.kind === "system" ? "[system]" : (item.row.body ?? "").replace(/\s+/g, " ").slice(0, 120);
      return `[${messageRouteTag(item)} score=${item.score}] ${id} ${who}: ${body}`;
    })
    .join("\n");
}
