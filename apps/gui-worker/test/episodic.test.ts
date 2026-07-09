import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMatchExpression,
  formatRecallHits,
  indexEpisodicMessages,
  isRecallableMessage,
  parseRecallArgs,
  recallEpisodic,
  runRecallCommand,
} from "../src/episodic.js";
import { createFakeSql } from "./fake-sql.js";

test("isRecallableMessage keeps human/agent text and drops system/empty", () => {
  assert.equal(isRecallableMessage({ id: "m1", conversation_id: "c", author_kind: "agent", body: "hello" }), true);
  assert.equal(isRecallableMessage({ id: "m2", conversation_id: "c", author_kind: "human", body: "hi" }), true);
  assert.equal(
    isRecallableMessage({ id: "m3", conversation_id: "c", author_kind: "agent", kind: "system", body: "x" }),
    false,
  );
  assert.equal(isRecallableMessage({ id: "m4", conversation_id: "c", author_kind: "agent", body: "   " }), false);
  assert.equal(isRecallableMessage({ id: "m5", conversation_id: "c", author_kind: "human" }), false);
  assert.equal(isRecallableMessage({ conversation_id: "c", author_kind: "human", body: "no id" }), false);
});

test("indexEpisodicMessages indexes recallable messages once and dedupes", () => {
  const sql = createFakeSql();
  const messages = [
    {
      id: "m1",
      conversation_id: "c1",
      author_kind: "human",
      author_name: "suk",
      body: "deploy the vless worker tonight",
      created_at: 1,
    },
    {
      id: "m2",
      conversation_id: "c1",
      author_kind: "agent",
      author_name: "Ops",
      kind: "system",
      body: "system note",
      created_at: 2,
    },
    {
      id: "m3",
      conversation_id: "c1",
      author_kind: "agent",
      author_name: "Dev",
      body: "I finished the migration",
      created_at: 3,
    },
  ];
  assert.equal(indexEpisodicMessages(sql, messages), 2);
  // re-indexing the same ids writes nothing new
  assert.equal(indexEpisodicMessages(sql, messages), 0);
});

test("buildMatchExpression tokenizes and quotes, tolerating punctuation", () => {
  assert.equal(buildMatchExpression("deploy vless"), '"deploy" OR "vless"');
  assert.equal(buildMatchExpression("  hello, world!  "), '"hello" OR "world"');
  assert.equal(buildMatchExpression("!@#$"), "");
  assert.equal(buildMatchExpression('say "hi"'), '"say" OR "hi"');
});

test("recallEpisodic finds indexed messages by keyword and respects the conversation filter", () => {
  const sql = createFakeSql();
  indexEpisodicMessages(sql, [
    {
      id: "m1",
      conversation_id: "c1",
      author_kind: "human",
      author_name: "suk",
      body: "deploy the vless worker tonight",
      created_at: 1,
    },
    {
      id: "m2",
      conversation_id: "c2",
      author_kind: "agent",
      author_name: "Dev",
      body: "the vless config is ready",
      created_at: 2,
    },
  ]);
  const all = recallEpisodic(sql, "vless");
  assert.equal(all.length, 2);
  const scoped = recallEpisodic(sql, "vless", { conversationId: "c2" });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].conversation_id, "c2");
  assert.equal(recallEpisodic(sql, "nonexistentterm").length, 0);
  assert.equal(recallEpisodic(sql, "   ").length, 0);
});

test("parseRecallArgs separates query from flags", () => {
  assert.deepEqual(parseRecallArgs(["vless", "deploy"]), {
    query: "vless deploy",
    limit: undefined,
    conversationId: undefined,
  });
  assert.deepEqual(parseRecallArgs(["vless", "--limit", "3", "--conversation", "c2"]), {
    query: "vless",
    limit: 3,
    conversationId: "c2",
  });
  assert.deepEqual(parseRecallArgs(["topic", "--in", "c9"]), {
    query: "topic",
    limit: undefined,
    conversationId: "c9",
  });
});

test("formatRecallHits and runRecallCommand produce useful output", () => {
  assert.match(formatRecallHits([], "vless"), /No episodic memory found for: vless/);
  const sql = createFakeSql();
  indexEpisodicMessages(sql, [
    {
      id: "m1",
      conversation_id: "c1",
      author_kind: "human",
      author_name: "suk",
      body: "deploy the vless worker tonight",
      created_at: 1700000000000,
    },
  ]);
  const out = runRecallCommand(sql, ["vless"]);
  assert.match(out, /\[c1\]/);
  assert.match(out, /suk: /);
  assert.match(out, /vless/);
  assert.match(runRecallCommand(sql, []), /usage: king-ai recall/);
  assert.match(runRecallCommand(undefined, ["vless"]), /episodic recall unavailable/);
});
