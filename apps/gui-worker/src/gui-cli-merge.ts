export type GuiCliMergeStatus = "queued" | "testing" | "merged" | "conflict" | "failed";

export type GuiCliMergeRequest = {
  id: string;
  taskId?: string;
  capsuleId?: string;
  branch: string;
  agentId: string;
  targetBranch: string;
  status: GuiCliMergeStatus | string;
  createdAt: number;
  updatedAt: number;
  mergedAt?: number;
  error?: string;
};

export type GuiCliMergeCapsule = {
  id: string;
  status: string;
  updated_at: number;
};

export type GuiCliMergeTask = {
  status: string;
  result?: string;
  updated_at: number;
};

export type RunMergeCommandDeps<
  S extends {
    mergeQueue: GuiCliMergeRequest[];
    capsules: GuiCliMergeCapsule[];
    tasks: GuiCliMergeTask[];
  },
  M extends GuiCliMergeRequest,
> = {
  defaultAgentId: string;
  findMergeRequest: (state: S, id: string | undefined) => M | undefined;
  findCapsule: (state: S, id: string | undefined) => GuiCliMergeCapsule | undefined;
  lookupTask: (state: S, id: string | undefined) => { task?: GuiCliMergeTask; error: string };
  formatMergeRequestLine: (request: M) => string;
  readOption: (args: string[], flag: string) => string | undefined;
  isSafeBranchName: (value: string) => boolean;
  isMergeStatus: (value: string) => value is GuiCliMergeStatus;
};

export function runMergeCommand<
  S extends {
    mergeQueue: GuiCliMergeRequest[];
    capsules: GuiCliMergeCapsule[];
    tasks: GuiCliMergeTask[];
  },
  M extends GuiCliMergeRequest,
>(state: S, args: string[], deps: RunMergeCommandDeps<S, M>): string {
  const cmd = args[0] || "list";
  if (cmd === "list") {
    const status = deps.readOption(args, "--status");
    const rows = state.mergeQueue.filter((request) => !status || request.status === status) as M[];
    if (rows.length === 0) return "No merge requests found.";
    return (
      rows.map((request) => deps.formatMergeRequestLine(request)).join("\n") + `\n\n${rows.length} merge request(s)`
    );
  }
  if (cmd === "get") {
    const request = deps.findMergeRequest(state, args[1]);
    return request ? JSON.stringify(request, null, 2) : `merge request not found: ${args[1] || ""}`;
  }
  if (cmd === "enqueue") {
    const capsule = deps.findCapsule(state, deps.readOption(args, "--capsule"));
    const branch = deps.readOption(args, "--branch") || (capsule as { branch?: string } | undefined)?.branch;
    const taskId = deps.readOption(args, "--task") || (capsule as { taskId?: string } | undefined)?.taskId;
    const agentId =
      deps.readOption(args, "--agent") ||
      (capsule as { ownerAgent?: string } | undefined)?.ownerAgent ||
      deps.defaultAgentId;
    const targetBranch = deps.readOption(args, "--target") || "main";
    if (!branch)
      return "usage: king-ai merge enqueue --branch <name> [--task id] [--capsule id] [--agent id] [--target main]";
    if (!deps.isSafeBranchName(branch)) return `invalid branch name: ${branch}`;
    if (!deps.isSafeBranchName(targetBranch)) return `invalid branch name: ${targetBranch}`;
    const existing = state.mergeQueue.find(
      (request) => request.branch === branch && request.status !== "merged" && request.status !== "failed",
    );
    if (existing) return `merge request already queued ${existing.id}`;
    const now = Date.now();
    const request = {
      id: `merge-${now}-${Math.random().toString(36).slice(2)}`,
      taskId,
      capsuleId: capsule?.id || deps.readOption(args, "--capsule"),
      branch,
      agentId,
      targetBranch,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    } as M;
    state.mergeQueue.push(request);
    if (capsule && capsule.status === "open") {
      capsule.status = "in_review";
      capsule.updated_at = now;
    }
    return `merge queued ${request.id} branch=${request.branch} target=${request.targetBranch}`;
  }
  if (cmd === "mark") {
    const request = deps.findMergeRequest(state, args[1]);
    const status = args[2];
    if (!request) return `merge request not found: ${args[1] || ""}`;
    if (!deps.isMergeStatus(status))
      return "usage: king-ai merge mark <id> queued|testing|merged|conflict|failed [--error text]";
    request.status = status;
    request.updatedAt = Date.now();
    request.error = deps.readOption(args, "--error") ?? request.error;
    if (status === "merged") {
      request.mergedAt = request.updatedAt;
      const capsule = deps.findCapsule(state, request.capsuleId);
      if (capsule) {
        capsule.status = "merged";
        capsule.updated_at = request.updatedAt;
      }
      const task = deps.lookupTask(state, request.taskId).task;
      if (task) {
        task.status = "done";
        task.result = task.result || `merged via ${request.id}`;
        task.updated_at = request.updatedAt;
      }
    }
    return `merge ${request.id} marked ${request.status}${request.error ? ` error=${request.error}` : ""}`;
  }
  return "usage: king-ai merge enqueue|list|get|mark";
}
