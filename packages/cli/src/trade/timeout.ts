/** Shared timeout helper for daemon ticks and verify-tg steps. */

export async function withTimeout<T>(label: string, timeoutMs: number, task: () => Promise<T>): Promise<T> {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
