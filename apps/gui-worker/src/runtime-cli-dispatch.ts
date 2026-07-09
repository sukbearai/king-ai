import { runtimeCliHelp } from "./runtime-cli-help.js";

export type RuntimeCliReject = { kind: "reject"; result: string };
export type RuntimeCliSuccess = { kind: "success"; result: string };
export type RuntimeCliDispatchResult = RuntimeCliReject | RuntimeCliSuccess;

export type RuntimeCliPayload = {
  argv?: string[];
  agentId?: string;
  tokenAgentId?: string;
  engine?: string;
  runId?: string;
  contract?: unknown;
  authUser?: { name?: string | null; email?: string | null };
};

export type RuntimeCliDispatchInput<S, A> = {
  argv: string[];
  state: S;
  actor: A;
  authorEngine: string;
  runContract: unknown;
  payload: RuntimeCliPayload;
};

export type RuntimeCliDeps<S, A> = {
  defaultAgentId: string;
  findConversation: (
    state: S,
    id?: string,
  ) => { id: string; title: string; kind?: string; updated_at?: number } | undefined;
  validateRunContractAction: (
    state: S,
    runContract: unknown,
    actor: A,
    action: { command: string; conversationId?: string; taskId?: string },
  ) => string | undefined;
  unreadMessagesFor: (state: S, agentId: string) => unknown[];
  isRuntimeVisibleMessage: (message: { conversation_id?: string }) => boolean;
  pendingBelongsToAgent: (message: { to_agent_id?: string }, actor: A) => boolean;
  validateReply?: (
    state: S,
    actor: A,
    conversation: { id: string; title: string; kind?: string; updated_at?: number },
    body: string,
  ) => string | undefined;
  recordRunAction: (
    state: S,
    runId: string | undefined,
    runContract: unknown,
    actor: A,
    action: string,
    detail: Record<string, unknown>,
  ) => void;
  agentStateSummary: (state: S, actor: A) => unknown;
  formatRosterAgent: (summary: unknown) => string;
  buildRuntimePreamble: (
    state: S,
    options: {
      agentId: string;
      reason: string;
      runId?: string;
      steerReason?: string;
    },
  ) => string;
  readOption: (args: string[], flag: string) => string | undefined;
  displayNameForHuman: (state: S, user: RuntimeCliPayload["authUser"]) => string;
  isTaskMutationCommand: (args: string[]) => boolean;
  isCliUsageOrError: (result: string) => boolean;
  stateCommand: (state: S, args: string[]) => Promise<string>;
  agentsCommand: (state: S, args: string[]) => string;
  observeCommand: (state: S, args: string[]) => string;
  loopCommand: (state: S, args: string[]) => string;
  cardCommand: (state: S, args: string[]) => string;
  taskCommand: (state: S, args: string[], actor: A) => string;
  initiativeCommand: (state: S, args: string[]) => string;
  capsuleCommand: (state: S, args: string[]) => string;
  mergeCommand: (state: S, args: string[]) => string;
  evalCommand: (state: S, args: string[]) => string;
  feedbackCommand: (state: S, args: string[]) => string;
  reviewCommand: (state: S, args: string[]) => string;
  routeCommand: (state: S, args: string[]) => string;
  calendarCommand: (state: S, args: string[]) => string;
  claimCommand: (state: S, args: string[], actor: A) => string;
  unclaimCommand: (state: S, args: string[]) => string;
  dmCommand: (state: S, args: string[], actor: A) => string;
  reactCommand: (state: S, args: string[], actor: A) => string;
  docCommand: (state: S, args: string[]) => string;
  artifactCommand: (state: S, args: string[], actor: A) => string;
  contextCommand: (state: S, args: string[], actor: A) => string;
  hypothesisCommand: (state: S, args: string[], actor: A) => string;
  planCommand: (state: S, args: string[]) => string;
  safetyCommand: (state: S, args: string[]) => string;
  sendCommand: (state: S, args: string[], actor: A) => string;
  recvCommand: (state: S, args: string[]) => string;
  recallCommand: (args: string[]) => string;
  escalateCommand: (state: S, args: string[], actor: A) => string;
  agendaJson: (agentId: string) => Promise<unknown>;
  getStateField: {
    messages: (state: S) => Array<{
      id?: string;
      conversation_id?: string;
      author_kind?: string;
      author_name?: string;
      status?: string;
      body?: string;
      to_agent_id?: string;
      readBy?: string[];
    }>;
    pushMessage: (state: S, message: Record<string, unknown>) => void;
    agents: (state: S) => Array<{ id: string; name: string; role?: string; engine?: string }>;
    composing: (state: S) => Array<{
      conversationId: string;
      agentName: string;
      claimed_at: number;
      expires_at: number;
    }>;
    setComposing: (
      state: S,
      composing: Array<{
        conversationId: string;
        agentName: string;
        claimed_at: number;
        expires_at: number;
      }>,
    ) => void;
    claims: (state: S) => Array<{ conversationId: string; name: string; owner: string }>;
    statusLog: (state: S) => Array<{ status?: string }>;
    availableEngines: (state: S) => string[];
  };
  actorField: {
    id: (actor: A) => string;
    name: (actor: A) => string;
    engine: (actor: A) => string | undefined;
    json: (actor: A) => unknown;
  };
};

function reject(result: string): RuntimeCliReject {
  return { kind: "reject", result };
}

function success(result: string): RuntimeCliSuccess {
  return { kind: "success", result };
}

export async function dispatchRuntimeCli<S, A>(
  input: RuntimeCliDispatchInput<S, A>,
  deps: RuntimeCliDeps<S, A>,
): Promise<RuntimeCliDispatchResult> {
  const { argv, state, actor, authorEngine, runContract, payload } = input;
  const actorId = deps.actorField.id(actor);
  const actorName = deps.actorField.name(actor);

  if (argv[0] === "reply") {
    const conversationId = argv[1] || "king-ai-convo";
    const contractError = deps.validateRunContractAction(state, runContract, actor, {
      command: "reply",
      conversationId,
    });
    if (contractError) return reject(contractError);
    const conversation = deps.findConversation(state, conversationId);
    if (!conversation) return reject(`conversation not found: ${conversationId}`);
    const quoteIdx = argv.indexOf("--quote");
    const quoted = quoteIdx >= 0 ? argv[quoteIdx + 1] : undefined;
    const bodyArgs = argv.slice(2).filter((_, idx) => {
      const absoluteIdx = idx + 2;
      return absoluteIdx !== quoteIdx && absoluteIdx !== quoteIdx + 1;
    });
    const body = bodyArgs.join(" ").trim() || "(empty reply)";
    const replyError = deps.validateReply?.(state, actor, conversation, body);
    if (replyError) return reject(replyError);
    const now = Date.now();
    const messages = deps.getStateField.messages(state);
    const pending = [...messages]
      .reverse()
      .find(
        (message) =>
          message.conversation_id === conversation.id &&
          message.author_kind === "agent" &&
          message.status === "pending" &&
          deps.pendingBelongsToAgent(message, actor),
      );
    const reply = {
      id: `msg-${now}-${Math.random().toString(36).slice(2)}`,
      conversation_id: conversation.id,
      conversation_title: conversation.title,
      conversation_kind: conversation.kind,
      author_name: actorName,
      author_kind: "agent",
      author_agent_id: actorId,
      author_engine: authorEngine,
      status: "done",
      kind: "message",
      body,
      quoted_message_id: quoted,
      created_at: now,
      readBy: [actorId],
    };
    if (pending) {
      Object.assign(pending, {
        author_name: reply.author_name,
        author_agent_id: reply.author_agent_id,
        author_engine: reply.author_engine,
        status: reply.status,
        body: reply.body,
        quoted_message_id: reply.quoted_message_id,
        created_at: reply.created_at,
        to_agent_id: undefined,
        readBy: reply.readBy,
      });
    } else {
      deps.getStateField.pushMessage(state, reply);
    }
    conversation.updated_at = now;
    deps.recordRunAction(state, payload.runId, runContract, actor, "reply", {
      conversationId: conversation.id,
      summary: body.slice(0, 160),
    });
    return success("reply posted");
  }

  if (argv[0] === "state") return success(await deps.stateCommand(state, argv.slice(1)));
  if (argv[0] === "inbox") return success(JSON.stringify(deps.unreadMessagesFor(state, actorId), null, 2));

  if (argv[0] === "messages") {
    const conversationId = argv[1] || "king-ai-convo";
    if (!deps.findConversation(state, conversationId)) return reject(`conversation not found: ${conversationId}`);
    const tailIdx = argv.indexOf("--tail");
    const tail = tailIdx >= 0 ? Number(argv[tailIdx + 1]) : 0;
    const rows = deps.getStateField
      .messages(state)
      .filter((m) => m.conversation_id === conversationId && deps.isRuntimeVisibleMessage(m));
    return success(JSON.stringify(tail > 0 ? rows.slice(-tail) : rows, null, 2));
  }

  if (argv[0] === "glance") {
    const conversationId = argv[1] || "king-ai-convo";
    if (!deps.findConversation(state, conversationId)) return reject(`conversation not found: ${conversationId}`);
    const rows = deps.getStateField
      .messages(state)
      .filter((m) => m.conversation_id === conversationId && deps.isRuntimeVisibleMessage(m))
      .slice(-10);
    const now = Date.now();
    const composing = deps.getStateField.composing(state).filter((claim) => claim.expires_at > now);
    deps.getStateField.setComposing(state, composing);
    const composingLines = composing
      .filter((claim) => claim.conversationId === conversationId)
      .sort((a, b) => a.claimed_at - b.claimed_at)
      .map(
        (claim) =>
          `Composing: ${claim.agentName} (claimed ${Math.max(0, (now - claim.claimed_at) / 1000).toFixed(1)}s ago)`,
      )
      .join("\n");
    const claims = deps.getStateField
      .claims(state)
      .filter((claim) => claim.conversationId === conversationId)
      .map((claim) => `Claim: ${claim.name} by ${claim.owner}`)
      .join("\n");
    const result =
      rows.map((m) => `[${m.id}] ${m.author_name}${m.author_kind === "agent" ? " ▸ME" : ""}: ${m.body}`).join("\n") +
      (claims ? `\n${claims}` : "") +
      (composingLines ? `\n${composingLines}` : "");
    return success(result);
  }

  if (argv[0] === "roster" || argv[0] === "participants") {
    return success(
      deps.getStateField
        .agents(state)
        .map((agent) => deps.formatRosterAgent(deps.agentStateSummary(state, agent as A)))
        .join("\n"),
    );
  }

  if (argv[0] === "preamble") {
    return success(
      deps.buildRuntimePreamble(state, {
        agentId: deps.readOption(argv.slice(1), "--agent") || argv[1] || deps.defaultAgentId,
        reason: deps.readOption(argv.slice(1), "--reason") || "cli",
        runId: deps.readOption(argv.slice(1), "--run"),
        steerReason: deps.readOption(argv.slice(1), "--steer-reason"),
      }),
    );
  }

  if (argv[0] === "agents") return success(deps.agentsCommand(state, argv.slice(1)));

  if (argv[0] === "contacts") {
    const query = argv.slice(1).join(" ").trim().toLowerCase();
    const humanName = deps.displayNameForHuman(state, payload.authUser);
    const rows = [
      ...deps.getStateField.agents(state).map((agent) => ({
        id: agent.id,
        name: agent.name,
        kind: "agent",
        role: agent.role,
        engine: agent.engine ?? "auto",
      })),
      { id: "gui-human", name: humanName, kind: "human", role: "Runtime operator", engine: undefined },
    ];
    const filtered = query
      ? rows.filter((row) =>
          [row.id, row.name, row.kind, row.role, row.engine].filter(Boolean).join(" ").toLowerCase().includes(query),
        )
      : rows;
    return success(
      filtered
        .map((row) => `${row.id}\t${row.name}\t${row.kind}\t${row.role}${row.engine ? `\t${row.engine}` : ""}`)
        .join("\n"),
    );
  }

  if (argv[0] === "whoami") return success(JSON.stringify(deps.agentStateSummary(state, actor), null, 2));

  if (argv[0] === "status") {
    return success(
      JSON.stringify(
        {
          agent: deps.actorField.json(actor),
          agentState: deps.agentStateSummary(state, actor),
          status: deps.getStateField.statusLog(state).at(-1)?.status ?? "unknown",
          availableEngines: deps.getStateField.availableEngines(state),
        },
        null,
        2,
      ),
    );
  }

  if (argv[0] === "observe" || argv[0] === "watch") return success(deps.observeCommand(state, argv.slice(1)));
  if (argv[0] === "loop") return success(deps.loopCommand(state, argv.slice(1)));
  if (argv[0] === "card") return success(deps.cardCommand(state, argv.slice(1)));

  if (argv[0] === "task") {
    // Only id-targeted mutations carry a taskId to validate against the run contract. `task create`
    // makes a new task (argv[2] is the title, not an existing id), and read/usage subcommands
    // (`list`, `get`, `--help`, `--json`) must never be gated by the contract — otherwise an option
    // flag gets misread as a taskId and trips a bogus "does not match wake task" rejection that even
    // blocks the agent from inspecting its own tasks.
    const mutates = deps.isTaskMutationCommand(argv.slice(1));
    const taskActionId = mutates && argv[1] !== "create" && argv[2] && !argv[2].startsWith("-") ? argv[2] : undefined;
    const contractError = deps.validateRunContractAction(state, runContract, actor, {
      command: "task",
      taskId: taskActionId,
    });
    if (contractError) return reject(contractError);
    const result = deps.taskCommand(state, argv.slice(1), actor);
    if (mutates && !deps.isCliUsageOrError(result)) {
      deps.recordRunAction(state, payload.runId, runContract, actor, "task", {
        taskId: taskActionId,
        summary: result.slice(0, 160),
      });
    }
    return success(result);
  }

  if (argv[0] === "initiative") return success(deps.initiativeCommand(state, argv.slice(1)));
  if (argv[0] === "capsule") return success(deps.capsuleCommand(state, argv.slice(1)));
  if (argv[0] === "merge") return success(deps.mergeCommand(state, argv.slice(1)));
  if (argv[0] === "eval" || argv[0] === "evaluate") return success(deps.evalCommand(state, argv.slice(1)));
  if (argv[0] === "feedback") return success(deps.feedbackCommand(state, argv.slice(1)));
  if (argv[0] === "review") return success(deps.reviewCommand(state, argv.slice(1)));
  if (argv[0] === "route") return success(deps.routeCommand(state, argv.slice(1)));
  if (argv[0] === "calendar") return success(deps.calendarCommand(state, argv.slice(1)));
  if (argv[0] === "claim") return success(deps.claimCommand(state, argv.slice(1), actor));
  if (argv[0] === "unclaim") return success(deps.unclaimCommand(state, argv.slice(1)));
  if (argv[0] === "dm") return success(deps.dmCommand(state, argv.slice(1), actor));
  if (argv[0] === "react" || argv[0] === "reaction") return success(deps.reactCommand(state, argv.slice(1), actor));
  if (argv[0] === "doc") return success(deps.docCommand(state, argv.slice(1)));
  if (argv[0] === "artifact") return success(deps.artifactCommand(state, argv.slice(1), actor));
  if (argv[0] === "context") return success(deps.contextCommand(state, argv.slice(1), actor));
  if (argv[0] === "hypothesis") return success(deps.hypothesisCommand(state, argv.slice(1), actor));
  if (argv[0] === "plan") return success(deps.planCommand(state, argv.slice(1)));
  if (argv[0] === "safety" || argv[0] === "approval") return success(deps.safetyCommand(state, argv.slice(1)));
  if (argv[0] === "send") return success(deps.sendCommand(state, argv.slice(1), actor));
  if (argv[0] === "recv") return success(deps.recvCommand(state, argv.slice(1)));
  if (argv[0] === "recall") return success(deps.recallCommand(argv.slice(1)));
  if (argv[0] === "escalate") return success(deps.escalateCommand(state, argv.slice(1), actor));
  if (argv[0] === "agenda") return success(JSON.stringify(await deps.agendaJson(actorId), null, 2));
  if (argv[0] === "help" || argv[0] === "--help") return success(runtimeCliHelp());
  return success(`gui runtime received: ${argv.join(" ")}`);
}
