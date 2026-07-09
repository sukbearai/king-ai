export function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

export function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function requestKeepAlive(writer: WritableStreamDefaultWriter<Uint8Array>, cleanup: () => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    cleanup();
  };
  const tick = async () => {
    if (stopped) return;
    try {
      await writer.write(encode(": keepalive\n\n"));
      if (!stopped) timer = setTimeout(tick, 15000);
    } catch {
      stop();
    }
  };
  timer = setTimeout(tick, 15000);
  void writer.closed.catch(() => undefined).finally(stop);
}
