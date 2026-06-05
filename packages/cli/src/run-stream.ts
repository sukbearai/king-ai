export type RunStreamTerminal = "running" | "done" | "error" | "interrupted";
export type RunStreamFooter = "thinking" | "tool_running" | "streaming" | null;
export type RunStreamEvent =
  | { type: "reasoning_delta"; text: string }
  | { type: "message_delta"; text: string }
  | { type: "tool_started"; id?: string; name: string; input?: string }
  | { type: "tool_delta"; id?: string; text: string }
  | { type: "tool_done"; id?: string; output?: string; error?: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "interrupted" };

export interface RunStreamTool {
  id: string;
  name: string;
  input?: string;
  output?: string;
  status: "running" | "done" | "error";
}

export interface RunStreamState {
  reasoning: string;
  message: string;
  tools: RunStreamTool[];
  terminal: RunStreamTerminal;
  footer: RunStreamFooter;
  error?: string;
}

export function initialRunStreamState(): RunStreamState {
  return {
    reasoning: "",
    message: "",
    tools: [],
    terminal: "running",
    footer: "thinking"
  };
}

export function reduceRunStream(state: RunStreamState, event: RunStreamEvent): RunStreamState {
  if (state.terminal !== "running") return state;
  if (event.type === "reasoning_delta") {
    return { ...state, reasoning: state.reasoning + event.text, footer: "thinking" };
  }
  if (event.type === "message_delta") {
    return { ...state, message: state.message + event.text, footer: "streaming" };
  }
  if (event.type === "tool_started") {
    return {
      ...state,
      footer: "tool_running",
      tools: [...state.tools, { id: event.id ?? `tool-${state.tools.length + 1}`, name: event.name, input: event.input, status: "running" }]
    };
  }
  if (event.type === "tool_delta") {
    return updateTool(state, event.id, (tool) => ({
      ...tool,
      output: `${tool.output ?? ""}${event.text}`,
      status: "running"
    }));
  }
  if (event.type === "tool_done") {
    return updateTool(state, event.id, (tool) => ({
      ...tool,
      output: event.output ?? tool.output,
      status: event.error ? "error" : "done"
    }));
  }
  if (event.type === "done") return { ...state, terminal: "done", footer: null };
  if (event.type === "error") return { ...state, terminal: "error", footer: null, error: event.message };
  return { ...state, terminal: "interrupted", footer: null };
}

export function renderRunStreamText(state: RunStreamState): string {
  const lines: string[] = [];
  if (state.reasoning) lines.push(`reasoning: ${compact(state.reasoning, 500)}`);
  for (const tool of state.tools) {
    const status = tool.status === "running" ? "running" : tool.status;
    const detail = tool.output ? ` - ${compact(tool.output, 300)}` : "";
    lines.push(`tool ${status}: ${tool.name}${detail}`);
  }
  if (state.message) lines.push(state.message.trimEnd());
  if (state.terminal === "error" && state.error) lines.push(`error: ${state.error}`);
  if (state.terminal === "interrupted") lines.push("interrupted");
  return lines.join("\n").trim();
}

export function renderRunStreamCard(state: RunStreamState): {
  summary: string;
  sections: Array<{ kind: "reasoning" | "tool" | "message" | "status"; title: string; body: string; collapsed: boolean }>;
} {
  const sections: Array<{ kind: "reasoning" | "tool" | "message" | "status"; title: string; body: string; collapsed: boolean }> = [];
  if (state.reasoning) {
    sections.push({ kind: "reasoning", title: state.footer === "thinking" ? "Thinking" : "Reasoning", body: compact(state.reasoning, 1500), collapsed: state.footer !== "thinking" });
  }
  const priorTools = state.tools.length > 2 && state.terminal === "running" ? state.tools.slice(0, -1) : [];
  if (priorTools.length) {
    sections.push({
      kind: "tool",
      title: `${priorTools.length} tool calls`,
      body: priorTools.map((tool) => `${tool.status}: ${tool.name}`).join("\n"),
      collapsed: true
    });
  }
  const visibleTools = priorTools.length ? state.tools.slice(-1) : state.tools;
  for (const tool of visibleTools) {
    sections.push({
      kind: "tool",
      title: `${tool.status}: ${tool.name}`,
      body: compact([tool.input, tool.output].filter(Boolean).join("\n"), 1500) || "(no output)",
      collapsed: tool.status !== "running"
    });
  }
  if (state.message) sections.push({ kind: "message", title: "Reply", body: state.message, collapsed: false });
  if (state.terminal !== "running") {
    sections.push({ kind: "status", title: state.terminal, body: state.error ?? state.terminal, collapsed: false });
  }
  return { summary: summaryText(state), sections };
}

function updateTool(state: RunStreamState, id: string | undefined, update: (tool: RunStreamTool) => RunStreamTool): RunStreamState {
  const target = id ?? state.tools.at(-1)?.id;
  if (!target) return state;
  return {
    ...state,
    footer: "tool_running",
    tools: state.tools.map((tool) => tool.id === target ? update(tool) : tool)
  };
}

function summaryText(state: RunStreamState): string {
  if (state.terminal === "done") return "Completed";
  if (state.terminal === "error") return "Failed";
  if (state.terminal === "interrupted") return "Interrupted";
  if (state.footer === "tool_running") return "Calling tools";
  if (state.footer === "streaming") return "Streaming";
  return "Thinking";
}

function compact(value: string, max: number): string {
  const text = value.replace(/\s+$/g, "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
