import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Per-path write chain. Appends and compactions to the same append-only JSONL file are
 * serialized through this map so concurrent role activity (multiple agents writing the same
 * ledger) cannot interleave partial lines or race a compaction rewrite.
 */
const writeChains = new Map<string, Promise<unknown>>();

function withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(path) ?? Promise.resolve();
  // Run after the previous mutation settles, whether it resolved or rejected, so one failed
  // write never deadlocks the queue.
  const run = prev.then(fn, fn);
  writeChains.set(path, run.then(() => undefined, () => undefined));
  return run;
}

export async function appendJsonl(path: string, value: unknown): Promise<void> {
  await withPathLock(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "a" });
  });
}

export async function readJsonl(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8").catch((err: unknown) => {
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT") return "";
    throw err;
  });
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as unknown);
}

export interface CompactJsonlResult {
  path: string;
  records: number;
  written: number;
}

/**
 * Rewrite an append-only JSONL file into the reduced snapshot returned by `reduce` (typically the
 * merged latest state). The rewrite is atomic (temp file + rename) and holds the same write lock
 * as appendJsonl, so a compaction never races a concurrent append.
 */
export async function compactJsonl(path: string, reduce: (records: unknown[]) => unknown[]): Promise<CompactJsonlResult> {
  return withPathLock(path, async () => {
    const records = await readJsonl(path);
    const compacted = reduce(records);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.compact-${process.pid}-${Date.now()}.tmp`;
    const body = compacted.map((record) => JSON.stringify(record)).join("\n");
    await writeFile(tmp, body.length ? `${body}\n` : "", "utf8");
    await rename(tmp, path);
    return { path, records: records.length, written: compacted.length };
  });
}
