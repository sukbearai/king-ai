import { CURRENT_VERSION } from "./paths.js";

export interface WorkerHealthPayload {
  ok?: boolean;
  version?: string;
  runtimeFeatures?: string[];
  service?: string;
}

export interface WorkerHealthProbe {
  ok: boolean;
  serverUrl: string;
  version?: string;
  runtimeFeatures?: string[];
  error?: string;
}

export async function probeWorkerHealth(serverUrl: string, timeoutMs = 10_000): Promise<WorkerHealthProbe> {
  const base = serverUrl.trim().replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/health`, { signal: controller.signal });
    if (!res.ok) {
      return { ok: false, serverUrl: base, error: `HTTP ${res.status}` };
    }
    const body = await res.json() as WorkerHealthPayload;
    if (body.ok !== true) {
      return { ok: false, serverUrl: base, error: "worker reported unhealthy" };
    }
    return {
      ok: true,
      serverUrl: base,
      version: typeof body.version === "string" ? body.version : undefined,
      runtimeFeatures: Array.isArray(body.runtimeFeatures)
        ? body.runtimeFeatures.filter((item): item is string => typeof item === "string")
        : undefined
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, serverUrl: base, error: message };
  } finally {
    clearTimeout(timer);
  }
}

export function formatWorkerHealthProbe(probe: WorkerHealthProbe, cliVersion = CURRENT_VERSION): string[] {
  if (!probe.ok) {
    return [`x remote worker @ ${probe.serverUrl} - ${probe.error ?? "unreachable"}`];
  }
  const lines = [`o remote worker @ ${probe.serverUrl} - version ${probe.version ?? "unknown"}`];
  if (probe.version && probe.version !== cliVersion) {
    lines.push(`    ! worker ${probe.version} != local CLI ${cliVersion}`);
  } else if (probe.version) {
    lines.push(`    ok worker matches local CLI ${cliVersion}`);
  }
  if (probe.runtimeFeatures?.includes("wake-dedup")) {
    lines.push("    ok wake-dedup advertised");
  } else if (probe.runtimeFeatures?.length) {
    lines.push("    ! wake-dedup not advertised (older worker build)");
  }
  return lines;
}