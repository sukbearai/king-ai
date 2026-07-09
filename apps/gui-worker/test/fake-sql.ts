import type { SqlLike } from "../src/episodic.js";

// In-memory stand-in for the Durable Object SqlStorage used by episodic memory. It only needs
// to understand the exact statements episodic.ts issues; FTS ranking is approximated with a
// case-insensitive substring match over the OR-ed query terms (good enough for behaviour tests;
// real FTS5 runs in production).
export function createFakeSql(): SqlLike {
  const indexed = new Set<string>();
  const rows: Array<{ message_id: string; conversation_id: string; author: string; created_at: number; body: string }> =
    [];
  return {
    exec(query: string, ...bindings: unknown[]) {
      if (query.includes("CREATE")) return { toArray: () => [], rowsWritten: 0 };
      if (query.includes("INSERT OR IGNORE INTO episodic_log")) {
        const id = String(bindings[0]);
        if (indexed.has(id)) return { toArray: () => [], rowsWritten: 0 };
        indexed.add(id);
        return { toArray: () => [], rowsWritten: 1 };
      }
      if (query.includes("INSERT INTO episodic_fts")) {
        rows.push({
          message_id: String(bindings[0]),
          conversation_id: String(bindings[1]),
          author: String(bindings[2]),
          created_at: Number(bindings[3]),
          body: String(bindings[4]),
        });
        return { toArray: () => [], rowsWritten: 1 };
      }
      if (query.includes("FROM episodic_fts") && query.includes("MATCH")) {
        const match = String(bindings[0]);
        const hasConversation = query.includes("conversation_id = ?");
        const conversationId = hasConversation ? String(bindings[1]) : undefined;
        const limit = Number(bindings[hasConversation ? 2 : 1]) || 8;
        const terms = (match.match(/"([^"]+)"/g) ?? []).map((token) => token.replace(/"/g, "").toLowerCase());
        const hits = rows
          .filter((row) => !conversationId || row.conversation_id === conversationId)
          .filter((row) => terms.some((term) => row.body.toLowerCase().includes(term)))
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, limit)
          .map((row) => ({
            message_id: row.message_id,
            conversation_id: row.conversation_id,
            author: row.author,
            created_at: row.created_at,
            snip: row.body.slice(0, 60),
          }));
        return { toArray: () => hits, rowsWritten: 0 };
      }
      return { toArray: () => [], rowsWritten: 0 };
    },
  };
}
