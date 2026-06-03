export interface SseEvent {
  event?: string;
  data?: string;
  id?: string;
}

export async function* parseSseStream(body: AsyncIterable<Uint8Array | string>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder("utf-8");
  let buf = "";

  for await (const chunk of body) {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
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
