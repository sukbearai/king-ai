// Cross-session episodic memory backed by the SQLite-backed Durable Object (FTS5 full-text
// search over conversation messages). The live UI state (state.messages) stays the source of
// truth; this index is an additive mirror that survives conversation clears and lets agents
// recall relevant past discussion via `king-ai recall <query>`.

// Minimal slice of Cloudflare's SqlStorage we depend on, so the helpers can be unit-tested
// against a tiny in-memory fake without pulling in the full Workers runtime.
export interface SqlCursorLike {
  toArray(): Record<string, unknown>[];
  rowsWritten?: number;
}
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): SqlCursorLike;
}

export interface EpisodicMessage {
  id?: string;
  conversation_id?: string;
  author_name?: string;
  author_kind?: string;
  kind?: string;
  body?: string;
  created_at?: number;
}

export interface RecallHit {
  message_id: string;
  conversation_id: string;
  author: string;
  created_at: number;
  snippet: string;
}

export interface RecallOptions {
  limit?: number;
  conversationId?: string;
}

const RECALL_DEFAULT_LIMIT = 8;
const RECALL_MAX_LIMIT = 50;
const FTS_BODY_COLUMN_INDEX = 4; // (message_id, conversation_id, author, created_at, body)

export function ensureEpisodicSchema(sql: SqlLike): void {
  sql.exec("CREATE TABLE IF NOT EXISTS episodic_log (message_id TEXT PRIMARY KEY)");
  sql.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS episodic_fts USING fts5(message_id UNINDEXED, conversation_id UNINDEXED, author UNINDEXED, created_at UNINDEXED, body)"
  );
}

export function isRecallableMessage(message: EpisodicMessage): boolean {
  return Boolean(
    message.id &&
    message.conversation_id &&
    message.body &&
    message.body.trim() &&
    message.kind !== "system" &&
    (message.author_kind === "agent" || message.author_kind === "human")
  );
}

// Indexes any not-yet-seen human/agent messages. The episodic_log primary key dedupes across
// restarts; rowsWritten on the gate insert tells us whether to mirror the row into FTS.
export function indexEpisodicMessages(sql: SqlLike, messages: EpisodicMessage[]): number {
  ensureEpisodicSchema(sql);
  let indexed = 0;
  for (const message of messages) {
    if (!isRecallableMessage(message)) continue;
    const gate = sql.exec("INSERT OR IGNORE INTO episodic_log (message_id) VALUES (?)", message.id);
    if ((gate.rowsWritten ?? 0) <= 0) continue;
    sql.exec(
      "INSERT INTO episodic_fts (message_id, conversation_id, author, created_at, body) VALUES (?, ?, ?, ?, ?)",
      message.id,
      message.conversation_id,
      message.author_name ?? "",
      message.created_at ?? 0,
      message.body
    );
    indexed += 1;
  }
  return indexed;
}

// Build a safe FTS5 MATCH expression from free-form user text: tokenize to letters/digits,
// quote each token (FTS5 treats bare punctuation as syntax), and OR them for recall breadth.
export function buildMatchExpression(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens
    .filter((token) => token.length > 0)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" OR ");
}

export function recallEpisodic(sql: SqlLike, query: string, options: RecallOptions = {}): RecallHit[] {
  ensureEpisodicSchema(sql);
  const match = buildMatchExpression(query);
  if (!match) return [];
  const limit = Math.min(Math.max(Math.floor(options.limit ?? RECALL_DEFAULT_LIMIT), 1), RECALL_MAX_LIMIT);
  const snippet = `snippet(episodic_fts, ${FTS_BODY_COLUMN_INDEX}, '【', '】', '…', 12)`;
  const rows = options.conversationId
    ? sql.exec(
        `SELECT message_id, conversation_id, author, created_at, ${snippet} AS snip FROM episodic_fts WHERE episodic_fts MATCH ? AND conversation_id = ? ORDER BY rank LIMIT ?`,
        match,
        options.conversationId,
        limit
      ).toArray()
    : sql.exec(
        `SELECT message_id, conversation_id, author, created_at, ${snippet} AS snip FROM episodic_fts WHERE episodic_fts MATCH ? ORDER BY rank LIMIT ?`,
        match,
        limit
      ).toArray();
  return rows.map((row) => ({
    message_id: String(row.message_id ?? ""),
    conversation_id: String(row.conversation_id ?? ""),
    author: String(row.author ?? ""),
    created_at: Number(row.created_at ?? 0),
    snippet: String(row.snip ?? "")
  }));
}

export function parseRecallArgs(args: string[]): { query: string; limit?: number; conversationId?: string } {
  let limit: number | undefined;
  let conversationId: string | undefined;
  const words: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--limit") {
      const value = Number(args[index + 1]);
      if (Number.isFinite(value)) limit = value;
      index += 1;
      continue;
    }
    if (arg === "--conversation" || arg === "--in") {
      conversationId = args[index + 1];
      index += 1;
      continue;
    }
    words.push(arg);
  }
  return { query: words.join(" ").trim(), limit, conversationId };
}

export function formatRecallHits(hits: RecallHit[], query: string): string {
  if (hits.length === 0) return `No episodic memory found for: ${query}`;
  return hits
    .map((hit) => {
      const when = hit.created_at
        ? new Date(hit.created_at).toISOString().replace("T", " ").slice(0, 16)
        : "";
      return `[${hit.conversation_id}]${when ? ` ${when}` : ""} ${hit.author}: ${hit.snippet}`;
    })
    .join("\n");
}

export function runRecallCommand(sql: SqlLike | undefined, args: string[]): string {
  if (!sql) return "episodic recall unavailable on this runtime (no sql storage)";
  const { query, limit, conversationId } = parseRecallArgs(args);
  if (!query) return "usage: king-ai recall <query> [--limit n] [--conversation <id>]";
  try {
    const hits = recallEpisodic(sql, query, { limit, conversationId });
    return formatRecallHits(hits, query);
  } catch (error) {
    return `recall failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
