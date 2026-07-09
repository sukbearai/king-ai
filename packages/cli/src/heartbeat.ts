import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface HeartbeatData {
  pid: number;
  runId: string;
  lastTick: string;
  loopCount: number;
  version?: string;
  computerId?: string;
  serverUrl?: string;
}

export class FileHeartbeat {
  private loopCount = 0;

  constructor(
    private readonly path: string,
    private readonly data: Omit<HeartbeatData, "lastTick" | "loopCount">,
  ) {
    mkdirSync(dirname(this.path), { recursive: true });
  }

  get count(): number {
    return this.loopCount;
  }

  write(): HeartbeatData {
    const data: HeartbeatData = {
      ...this.data,
      lastTick: new Date().toISOString(),
      loopCount: this.loopCount,
    };
    writeFileSync(this.path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    return data;
  }

  tick(): HeartbeatData {
    this.loopCount += 1;
    return this.write();
  }
}
