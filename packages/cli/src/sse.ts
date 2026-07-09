export interface SseEvent {
  event?: string;
  data?: string;
  id?: string;
}

export const DEFAULT_SSE_MAX_BUFFER_BYTES = 1024 * 1024;

export async function* parseSseStream(
  body: AsyncIterable<Uint8Array | string>,
  options: { maxBufferBytes?: number } = {},
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder("utf-8");
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_SSE_MAX_BUFFER_BYTES;
  let buf = "";

  for await (const chunk of body) {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(buf, "utf8") > maxBufferBytes) {
      throw new Error(`SSE frame exceeded ${maxBufferBytes} bytes without a terminator`);
    }
    let splitAt: number;
    while ((splitAt = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, splitAt);
      buf = buf.slice(splitAt + 2);
      const event: SseEvent = {};

      for (const rawLine of block.split("\n")) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const field = line.slice(0, colon);
        const value = line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event.event = value;
        if (field === "id") event.id = value;
        if (field === "data") event.data = (event.data ?? "") + value;
      }

      if (event.event || event.data || event.id) yield event;
    }
  }
}
