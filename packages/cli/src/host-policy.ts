export type HostPolicyDecision = "allow" | "confirm_required";

export interface HostPolicyCheck {
  command: string;
  destructive: boolean;
  decision: HostPolicyDecision;
  reason: string;
  requiredConfirmation?: string;
}

export interface HostPolicyInput {
  confirmed?: unknown;
  confirmation?: unknown;
}

export function requiredHostConfirmation(command: string): string {
  return `allow:${command}`;
}

export function checkHostCommandPolicy(command: string, destructive: boolean, input?: HostPolicyInput): HostPolicyCheck {
  if (!destructive) {
    return {
      command,
      destructive,
      decision: "allow",
      reason: "read-only host command"
    };
  }

  const requiredConfirmation = requiredHostConfirmation(command);
  if (input?.confirmed === true || input?.confirmation === requiredConfirmation) {
    return {
      command,
      destructive,
      decision: "allow",
      reason: "destructive host command explicitly confirmed",
      requiredConfirmation
    };
  }

  return {
    command,
    destructive,
    decision: "confirm_required",
    reason: "destructive host command requires explicit confirmation",
    requiredConfirmation
  };
}

export function formatHostPolicyCheck(check: HostPolicyCheck): string {
  if (check.decision === "allow") {
    return `${check.command}: allowed (${check.reason})`;
  }
  return `${check.command}: confirmation required (${check.reason}; confirmation=${check.requiredConfirmation})`;
}
