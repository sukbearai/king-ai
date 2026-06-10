export type RemediationSeverity = "info" | "warning" | "error";
export type RemediationCategory = "missing_engine" | "auth" | "quota" | "rate_limit" | "context" | "session" | "runtime" | "unknown";

export interface RemediationAdvice {
  engine?: string;
  category: RemediationCategory;
  severity: RemediationSeverity;
  summary: string;
  detail?: string;
  actions: string[];
}

function has(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

export function engineInstallAdvice(engine: string): RemediationAdvice {
  return {
    engine,
    category: "missing_engine",
    severity: "error",
    summary: `${engine} CLI is not on PATH`,
    actions: [
      `Install the ${engine} CLI.`,
      `Run ${engine} once in a local terminal to finish login/setup.`,
      "Restart or re-run: king-ai agent computer --doctor"
    ]
  };
}

export function engineRemediationAdvice(engine: string, detail: string): RemediationAdvice {
  const text = detail || "unknown failure";
  const lower = text.toLowerCase();

  if (has(lower, /context window|context length|context_length_exceeded|maximum context|prompt is too long|input is too long|too many tokens/)) {
    return {
      engine,
      category: "context",
      severity: "warning",
      summary: `${engine} session context is full`,
      detail: text,
      actions: [
        "The daemon resets the affected engine session automatically.",
        "Wake the agent again to continue with a fresh session.",
        "If this repeats, reduce prompt/history size or ask the runtime to provide a shorter preamble."
      ]
    };
  }

  if (has(lower, /no (?:low|high) surrogate|unpaired surrogate|lone surrogate|surrogate in string|request body is not valid json/)) {
    return {
      engine,
      category: "session",
      severity: "warning",
      summary: `${engine} session was poisoned by malformed text`,
      detail: text,
      actions: [
        "The daemon resets the affected engine session automatically.",
        "Wake the agent again after the malformed message is removed or sanitized."
      ]
    };
  }

  if (has(lower, /\bquota\b|credit|billing|subscription|usage limit|session limit|insufficient_quota|resource_exhausted/)) {
    return {
      engine,
      category: "quota",
      severity: "error",
      summary: `${engine} quota or billing limit is blocking runs`,
      detail: text,
      actions: [
        `Open ${engine} locally and refresh quota, billing, credits, or subscription state.`,
        "Re-run: king-ai agent computer --doctor",
        "Wake the agent again after the quota issue is fixed."
      ]
    };
  }

  if (has(lower, /\b429\b|\b503\b|too many requests|rate.?limit|overloaded|service (temporarily )?unavailable/)) {
    return {
      engine,
      category: "rate_limit",
      severity: "warning",
      summary: `${engine} is temporarily rate-limited or unavailable`,
      detail: text,
      actions: [
        "Wait for the provider limit to clear.",
        "Re-run: king-ai agent computer --doctor",
        "Wake the agent again after the backoff period."
      ]
    };
  }

  if (has(lower, /auth|login|log(?:ged)? in|sign(?:ed)? in|token|api key|unauthorized|forbidden|\b401\b|\b403\b/)) {
    return {
      engine,
      category: "auth",
      severity: "error",
      summary: `${engine} authentication is not ready`,
      detail: text,
      actions: [
        `Open ${engine} locally and sign in again.`,
        "Make sure the daemon process has the same PATH and home config as your terminal.",
        "Re-run: king-ai agent computer --doctor"
      ]
    };
  }

  return {
    engine,
    category: "unknown",
    severity: "warning",
    summary: `${engine} failed; inspect daemon logs`,
    detail: text,
    actions: [
      "Check the daemon terminal or service logs for the full error.",
      "Re-run: king-ai agent computer --doctor",
      "Wake the agent again after fixing the local engine problem."
    ]
  };
}

export function formatRemediationAdvice(advice: RemediationAdvice): string {
  return [
    `${advice.summary}.`,
    ...advice.actions
  ].join(" ");
}

export function formatRemediationBlock(advice: RemediationAdvice): string {
  return [
    `${advice.severity}: ${advice.summary}`,
    advice.detail ? `  detail: ${advice.detail}` : "",
    ...advice.actions.map((action) => `  - ${action}`)
  ].filter(Boolean).join("\n");
}
