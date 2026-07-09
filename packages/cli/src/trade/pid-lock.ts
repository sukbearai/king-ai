import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TRADE_DAEMON_PID_PATH } from "../paths.js";

export interface PidLockHandle {
  path: string;
  release: () => Promise<void>;
}

function processAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire a single-instance lock for the trade daemon.
 * Stale pid files (dead process) are replaced.
 */
export async function acquireDaemonPidLock(path = TRADE_DAEMON_PID_PATH): Promise<PidLockHandle> {
  await mkdir(dirname(path), { recursive: true });

  try {
    const existing = (await readFile(path, "utf8")).trim();
    const oldPid = Number.parseInt(existing, 10);
    if (processAlive(oldPid) && oldPid !== process.pid) {
      throw new Error(`trade daemon already running (pid ${oldPid}); stop it or remove ${path} if stale`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("already running")) throw err;
    // missing file or unreadable — proceed
  }

  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, `${process.pid}\n`, "utf8");
  await rename(tmp, path);

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      const cur = (await readFile(path, "utf8")).trim();
      if (Number.parseInt(cur, 10) === process.pid) {
        await rm(path, { force: true });
      }
    } catch {
      // ignore
    }
  };

  return { path, release };
}
