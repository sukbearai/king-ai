import { normalizeAgentLifecycle } from "./lifecycle.js";
import type { AgentConfig, EngineId } from "./types.js";

export type AgentConfigWarningCode =
  | "idle-cached-without-resume"
  | "missing-preferred-engine"
  | "unknown-lifecycle";

export interface AgentConfigWarning {
  code: AgentConfigWarningCode;
  severity: "warning";
  summary: string;
  detail: string;
}

export function validateAgentConfig(agent: AgentConfig, effectiveEngine: EngineId | string, availableEngines: EngineId[] = []): AgentConfigWarning[] {
  const warnings: AgentConfigWarning[] = [];
  const lifecycle = normalizeAgentLifecycle(agent.lifecycle);
  if (agent.lifecycle && agent.lifecycle !== lifecycle) {
    warnings.push({
      code: "unknown-lifecycle",
      severity: "warning",
      summary: `unknown lifecycle ${agent.lifecycle} normalized to ${lifecycle}`,
      detail: "The daemon only understands on-demand, 24/7, idle_cached, and disabled."
    });
  }
  if (agent.engine && !availableEngines.includes(agent.engine)) {
    warnings.push({
      code: "missing-preferred-engine",
      severity: "warning",
      summary: `${agent.engine} is requested but not installed on this machine`,
      detail: `The daemon will use ${effectiveEngine || "the first available engine"} until ${agent.engine} is available.`
    });
  }
  if (lifecycle === "idle_cached" && effectiveEngine !== "claude") {
    warnings.push({
      code: "idle-cached-without-resume",
      severity: "warning",
      summary: "idle_cached has engine-specific resume semantics",
      detail: "Claude uses CLI session resume. Codex may reuse an app-server thread when available, but the daemon treats it as best-effort and falls back to a fresh thread."
    });
  }
  return warnings;
}
