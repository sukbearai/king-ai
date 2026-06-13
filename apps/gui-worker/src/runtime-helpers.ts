import type { RoutedRuntimeMessage } from "@suwujs/king-ai/message-routing";

export interface ConversationTeamLike {
  id?: string;
  kind?: "direct" | "group";
  teamMode?: "single" | "team" | "custom";
  coordinatorAgentId?: string;
}

export interface WakeResolveContext {
  defaultConversationId: string;
  defaultCoordinatorAgentId: string;
  defaultWorkerAgentId: string;
  fallbackAgentId: string;
  cards: Array<{ id: string; assignee?: string; claimedBy?: string }>;
  tasks: Array<{ id: string; assignee?: string }>;
  conversations: ConversationTeamLike[];
}

function normalizeAgentId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return id || undefined;
}

function coordinatorAgentIdFor(conversation: ConversationTeamLike, ctx: WakeResolveContext): string {
  return normalizeAgentId(conversation.coordinatorAgentId) ?? ctx.defaultCoordinatorAgentId;
}

export function shouldAutoDelegateMessage(conversation: ConversationTeamLike, messageBody = ""): boolean {
  const mode = conversation.teamMode ?? "team";
  if (mode === "single") return true;
  const body = messageBody.trim();
  if (!body) return false;
  if (/^(hi|hello|hey|thanks|thank you|ok|okay|yes|no)[!.?\s]*$/i.test(body)) return false;
  if (/^(你好|大家好|谢谢|在吗|收到)[!.?\s]*$/u.test(body)) return false;
  if (isGroupRollCallMessage(conversation, body)) return false;
  return true;
}

export function isGroupRollCallMessage(conversation: ConversationTeamLike, messageBody = ""): boolean {
  const mode = conversation.teamMode ?? "team";
  if (mode === "single") return false;
  const body = messageBody.trim();
  if (/\b(everyone|everybody|all hands|team)\b/i.test(body) && /\b(roll call|presence check|attendance check|reply with \d+)\b/i.test(body)) return true;
  if (/(所有人|大家|全员).*(回个?|回复|报个?)\s*\d+/.test(body)) return true;
  if (/(有人|都|还).{0,6}(在吗|在不在)/.test(body)) return true;
  return false;
}

export function triageResponseMode(
  conversation: ConversationTeamLike | undefined,
  top: RoutedRuntimeMessage | undefined,
  agentId: string
): "me" | "each" | "one-of-us" {
  if (top?.row.to_agent_id === agentId) return "me";
  if (conversation?.kind === "direct") return "me";
  const mode = conversation?.teamMode ?? "team";
  if (mode === "single") return "me";
  return "one-of-us";
}

export function resolveWakeData(ctx: WakeResolveContext, data: Record<string, unknown>): Record<string, unknown> {
  const at = typeof data.at === "number" ? data.at : Date.now();
  const base: Record<string, unknown> = { ...data, at };
  if (normalizeAgentId(base.agentId)) return base;
  if (base.resetState === true || base.importedState === true) return base;

  if (typeof base.cardId === "string") {
    const card = ctx.cards.find((row) => row.id === base.cardId || row.id.startsWith(base.cardId as string));
    const agentId = normalizeAgentId(card?.assignee) ?? normalizeAgentId(card?.claimedBy);
    if (agentId) return { ...base, agentId };
  }
  if (typeof base.taskId === "string") {
    const task = ctx.tasks.find((row) => row.id === base.taskId || row.id.startsWith(base.taskId as string));
    const agentId = normalizeAgentId(task?.assignee);
    if (agentId) return { ...base, agentId };
  }
  if (typeof base.clearedConversationId === "string") {
    const conversation = ctx.conversations.find((row) => row.id === base.clearedConversationId);
    if (conversation) return { ...base, agentId: coordinatorAgentIdFor(conversation, ctx) };
  }
  if (typeof base.conversationId === "string") {
    const conversation = ctx.conversations.find((row) => row.id === base.conversationId);
    if (conversation) return { ...base, agentId: coordinatorAgentIdFor(conversation, ctx) };
  }
  if (base.agenda === true) return { ...base, agentId: ctx.defaultWorkerAgentId };

  const fallbackConversation =
    ctx.conversations.find((row) => row.id === ctx.defaultConversationId) ?? ctx.conversations[0];
  if (fallbackConversation) return { ...base, agentId: coordinatorAgentIdFor(fallbackConversation, ctx) };
  return { ...base, agentId: ctx.fallbackAgentId };
}

export function resolveWakeEvent(ctx: WakeResolveContext, evt: { event: string; data: unknown }): { event: string; data: unknown } {
  if (evt.event !== "wake" || !evt.data || typeof evt.data !== "object") return evt;
  return { ...evt, data: resolveWakeData(ctx, evt.data as Record<string, unknown>) };
}

export function wakeEventVisibleToAgent(evt: { data: unknown }, agentId: string): boolean {
  if (!evt.data || typeof evt.data !== "object") return false;
  const data = evt.data as Record<string, unknown>;
  const target = normalizeAgentId(data.agentId);
  if (target) return target === agentId;
  // Reset/import and runtime config changes are computer-wide, so every connected runner sees them.
  if (data.resetState === true || data.importedState === true || data.config === true) return true;
  return false;
}

export interface WakeDedupMessage {
  id: string;
  conversation_id: string;
  author_kind: string;
  author_agent_id?: string;
  status?: string;
  quoted_message_id?: string;
  created_at: number;
  readBy: string[];
}

export interface WakeDedupTask {
  id: string;
  status: string;
  assignee?: string;
  requestMessageId?: string;
  conversationId?: string;
  coordinatorAgentId?: string;
}

export interface WakeDedupContext {
  messages: WakeDedupMessage[];
  tasks: WakeDedupTask[];
  conversations: ConversationTeamLike[];
}

export interface WakeSuppressResult {
  suppress: boolean;
  reason?: string;
  autoRead?: { conversationId: string; messageId: string; agentId: string };
}

function singleResponderConversation(ctx: WakeDedupContext, conversationId: string): ConversationTeamLike | undefined {
  return ctx.conversations.find((row) => row.id === conversationId);
}

function isSingleResponderConversation(conversation: ConversationTeamLike | undefined): boolean {
  if (!conversation) return false;
  return conversation.teamMode === "single" || conversation.kind === "direct";
}

export function agentReplyForMessage(ctx: WakeDedupContext, messageId: string, agentId: string): boolean {
  const message = ctx.messages.find((row) => row.id === messageId);
  if (!message) return false;

  const quotedReply = ctx.messages.some((row) =>
    row.status !== "pending" &&
    row.quoted_message_id === messageId &&
    row.author_kind === "agent" &&
    row.author_agent_id === agentId
  );
  if (quotedReply) return true;

  const conversation = singleResponderConversation(ctx, message.conversation_id);
  if (!isSingleResponderConversation(conversation)) return false;

  const convoMessages = ctx.messages
    .filter((row) => row.conversation_id === message.conversation_id && row.status !== "pending")
    .sort((a, b) => a.created_at - b.created_at);
  const index = convoMessages.findIndex((row) => row.id === messageId);
  if (index < 0) return false;
  return convoMessages.slice(index + 1).some((row) =>
    row.author_kind === "agent" && row.author_agent_id === agentId
  );
}

export function taskForRequestMessage(ctx: WakeDedupContext, messageId: string): WakeDedupTask | undefined {
  return ctx.tasks.find((row) => row.requestMessageId === messageId);
}

function taskSettledForAgent(task: WakeDedupTask, agentId: string): boolean {
  if (task.status === "done") return true;
  if (task.status === "review" && task.assignee !== agentId) return true;
  return false;
}

export function isMessageInboxSettled(ctx: WakeDedupContext, messageId: string, agentId: string): boolean {
  const message = ctx.messages.find((row) => row.id === messageId);
  if (!message || message.author_kind === "agent") return false;
  if (!agentReplyForMessage(ctx, messageId, agentId)) return false;

  const task = taskForRequestMessage(ctx, messageId);
  if (!task) return true;
  if (task.assignee === agentId) return taskSettledForAgent(task, agentId);
  return task.status === "done" || task.status === "review";
}

export function shouldSuppressAgentWake(ctx: WakeDedupContext, data: Record<string, unknown>): WakeSuppressResult {
  if (data.resetState === true || data.importedState === true || data.config === true) {
    return { suppress: false };
  }

  const agentId = normalizeAgentId(data.agentId);
  if (!agentId) return { suppress: false };

  const messageId =
    typeof data.messageId === "string" ? data.messageId :
      typeof data.requestId === "string" ? data.requestId :
        undefined;
  const taskId = typeof data.taskId === "string" ? data.taskId : undefined;
  const conversationId = typeof data.conversationId === "string" ? data.conversationId : undefined;

  const task = taskId
    ? ctx.tasks.find((row) => row.id === taskId)
    : messageId
      ? taskForRequestMessage(ctx, messageId)
      : undefined;
  const requestMessageId = messageId ?? task?.requestMessageId;

  if (!requestMessageId) return { suppress: false };

  if (!agentReplyForMessage(ctx, requestMessageId, agentId)) {
    return { suppress: false };
  }

  if (!task) {
    return {
      suppress: true,
      reason: "message already answered",
      autoRead: conversationId ? { conversationId, messageId: requestMessageId, agentId } : undefined
    };
  }

  if (task.assignee === agentId) {
    if (!taskSettledForAgent(task, agentId)) {
      return { suppress: false };
    }
    return {
      suppress: true,
      reason: "reply posted and assigned task settled",
      autoRead: {
        conversationId: conversationId ?? task.conversationId ?? "",
        messageId: requestMessageId,
        agentId
      }
    };
  }

  if (task.status === "done" && task.assignee && task.assignee !== agentId) {
    return {
      suppress: true,
      reason: "worker already answered; task handed to coordinator",
      autoRead: {
        conversationId: conversationId ?? task.conversationId ?? "",
        messageId: requestMessageId,
        agentId
      }
    };
  }

  return { suppress: false };
}

export function applyAgentReadUpTo(
  ctx: WakeDedupContext,
  spec: { conversationId: string; messageId: string; agentId: string }
): void {
  if (!spec.conversationId) return;
  const conversationMessages = ctx.messages.filter((row) => row.conversation_id === spec.conversationId);
  const cutoffIndex = conversationMessages.findIndex((row) => row.id === spec.messageId);
  const readable = cutoffIndex >= 0 ? conversationMessages.slice(0, cutoffIndex + 1) : conversationMessages;
  for (const message of readable) {
    if (!message.readBy.includes(spec.agentId)) message.readBy.push(spec.agentId);
  }
}
