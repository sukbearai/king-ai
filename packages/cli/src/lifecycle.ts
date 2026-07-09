import type { AgentLifecycle } from "./types.js";

export const DEFAULT_AGENT_LIFECYCLE: AgentLifecycle = "on-demand";

export function normalizeAgentLifecycle(value: unknown): AgentLifecycle {
  return value === "24/7" || value === "idle_cached" || value === "disabled" || value === "on-demand"
    ? value
    : DEFAULT_AGENT_LIFECYCLE;
}

export function shouldHostAgent(lifecycle: AgentLifecycle): boolean {
  return lifecycle !== "disabled";
}

export function runtimeLifecycleNote(lifecycle: AgentLifecycle): string {
  if (lifecycle === "disabled") return "disabled - not hosted by this daemon";
  if (lifecycle === "idle_cached")
    return "idle_cached - event-triggered; session reuse is best-effort through the selected engine";
  if (lifecycle === "24/7") return "24/7 - hosted continuously, but turns remain runtime-event driven in this daemon";
  return "on-demand - hosted and woken by runtime activity";
}
