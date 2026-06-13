import workerPackage from "../package.json" with { type: "json" };

export const WORKER_PACKAGE_VERSION = workerPackage.version;

/** Advertised runtime capabilities; bump when shipping ledger or GUI behavior changes. */
export const WORKER_RUNTIME_FEATURES = [
  "wake-dedup",
  "runtime-token-grace",
  "gui-messages-endpoint",
  "markdown-render-cache",
  "optimistic-conversation-switch",
  "lightweight-coordination",
  "sequential-coordination",
  "task-inbox-settle"
] as const;

export type WorkerRuntimeFeature = (typeof WORKER_RUNTIME_FEATURES)[number];

export interface WorkerHealthPayload {
  ok: true;
  service: "king-ai-gui-worker";
  version: string;
  cliPackage: string;
  runtimeFeatures: WorkerRuntimeFeature[];
  checkedAt: string;
}

export function buildWorkerHealthPayload(now = Date.now()): WorkerHealthPayload {
  return {
    ok: true,
    service: "king-ai-gui-worker",
    version: WORKER_PACKAGE_VERSION,
    cliPackage: `@suwujs/king-ai@${WORKER_PACKAGE_VERSION}`,
    runtimeFeatures: [...WORKER_RUNTIME_FEATURES],
    checkedAt: new Date(now).toISOString()
  };
}