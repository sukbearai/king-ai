export type GuiCliApprovalRequest = {
  id: string;
  action: string;
  context?: Record<string, unknown>;
  status: string;
  conversationId?: string;
  taskId?: string;
  createdAt: number;
  resolvedAt?: number;
  reason?: string;
};

export type RunSafetyCommandDeps<S extends { approvals: GuiCliApprovalRequest[] }, A extends GuiCliApprovalRequest> = {
  safetyActions: readonly string[];
  isSafetyAction: (value: string) => boolean;
  safetyCheck: (action: string) => { allowed: boolean };
  parseSafetyContext: (args: string[]) => Record<string, unknown>;
  stringContextValue: (context: Record<string, unknown>, key: string) => string | undefined;
  findApproval: (state: S, id: string | undefined) => A | undefined;
  formatApprovalLine: (approval: A) => string;
  readOption: (args: string[], flag: string) => string | undefined;
  stripOptions: (args: string[], flags: string[]) => string[];
};

export function runSafetyCommand<S extends { approvals: GuiCliApprovalRequest[] }, A extends GuiCliApprovalRequest>(
  state: S,
  args: string[],
  deps: RunSafetyCommandDeps<S, A>
): string {
  const cmd = args[0] || "list";
  if (cmd === "check") {
    const action = args[1];
    if (!deps.isSafetyAction(action)) {
      return `usage: king-ai safety check <action>\nknown actions: ${deps.safetyActions.join(", ")}`;
    }
    return deps.safetyCheck(action).allowed
      ? `allowed: ${action} does not require approval in this gui gate`
      : `approval required: ${action}`;
  }
  if (cmd === "request") {
    const action = args[1];
    if (!deps.isSafetyAction(action)) return "usage: king-ai safety request <action> [--reason text] [--context json]";
    if (deps.safetyCheck(action).allowed) return `allowed: ${action} does not require approval in this gui gate`;
    const context = deps.parseSafetyContext(args);
    const request = {
      id: `approval-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      action,
      context,
      status: "pending",
      conversationId: deps.stringContextValue(context, "conversationId"),
      taskId: deps.stringContextValue(context, "taskId"),
      createdAt: Date.now()
    } as A;
    state.approvals.push(request);
    return `approval requested ${request.id} action=${action}`;
  }
  if (cmd === "list" || cmd === "pending") {
    const status = cmd === "pending" ? "pending" : deps.readOption(args, "--status");
    const rows = state.approvals.filter((approval) => !status || approval.status === status) as A[];
    if (rows.length === 0) return "No approval requests found.";
    return rows.map((approval) => deps.formatApprovalLine(approval)).join("\n") + `\n\n${rows.length} approval request(s)`;
  }
  if (cmd === "get") {
    const request = deps.findApproval(state, args[1]);
    return request ? JSON.stringify(request, null, 2) : `approval not found: ${args[1] || ""}`;
  }
  if (cmd === "approve") {
    const request = deps.findApproval(state, args[1]);
    if (!request) return `approval not found: ${args[1] || ""}`;
    if (request.status !== "pending") return `Cannot approve ${request.id}: status=${request.status}`;
    request.status = "approved";
    request.resolvedAt = Date.now();
    return `approval approved ${request.id}`;
  }
  if (cmd === "deny") {
    const request = deps.findApproval(state, args[1]);
    if (!request) return `approval not found: ${args[1] || ""}`;
    if (request.status !== "pending") return `Cannot deny ${request.id}: status=${request.status}`;
    request.status = "denied";
    request.reason = deps.readOption(args, "--reason") || deps.stripOptions(args.slice(2), ["--reason"]).join(" ").trim() || "denied";
    request.resolvedAt = Date.now();
    return `approval denied ${request.id}: ${request.reason}`;
  }
  return "usage: king-ai safety check|request|list|get|approve|deny <action|approvalId>";
}
