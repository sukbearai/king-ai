import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatMessageRouteSummary,
  messageRouteTag,
  normalizeMessagePriority,
  normalizeMessageType,
  routeRuntimeMessage,
  sortRuntimeMessages
} from "../src/message-routing.js";

test("message routing classifies explicit and inferred message types", () => {
  assert.equal(normalizeMessageType({ message_type: "approval" }), "approval");
  assert.equal(normalizeMessageType({ body: "approval required before deploy" }), "approval");
  assert.equal(normalizeMessageType({ body: "blocked waiting on API" }), "blocker");
  assert.equal(normalizeMessageType({ body: "decision: ship it" }), "decision");
  assert.equal(normalizeMessageType({ kind: "system" }), "system");
  assert.equal(normalizeMessagePriority({ message_type: "blocker" }), "urgent");
  assert.equal(normalizeMessagePriority({ message_type: "decision" }), "steer");
});

test("message routing scores targeted urgent work ahead of normal chatter", () => {
  const routed = sortRuntimeMessages([
    {
      id: "m1",
      conversation_id: "group",
      conversation_kind: "group",
      author_name: "Peer",
      author_kind: "agent",
      body: "status update",
      created_at: 1
    },
    {
      id: "m2",
      conversation_id: "group",
      conversation_kind: "group",
      author_name: "Peer",
      author_kind: "agent",
      body: "blocked on API",
      message_type: "blocker",
      to_agent_id: "demo-agent",
      created_at: 2
    },
    {
      id: "m3",
      conversation_id: "dm",
      conversation_kind: "direct",
      author_name: "Human",
      author_kind: "human",
      body: "hello",
      created_at: 3
    }
  ], "demo-agent");

  assert.equal(routed[0].row.id, "m2");
  assert.equal(routed[0].route, "steer");
  assert.equal(routed[0].priority, "urgent");
  assert.equal(messageRouteTag(routed[0]), "steer/urgent/blocker");
  assert.equal(routed[2].row.id, "m1");
  assert.equal(routed[2].route, "monitor");
});

test("message routing ignores messages targeted to another agent", () => {
  const routed = routeRuntimeMessage({
    id: "m1",
    author_name: "Peer",
    author_kind: "agent",
    body: "@other-agent take this",
    to_agent_id: "other-agent"
  }, "demo-agent");
  assert.equal(routed.route, "ignore");
  assert.match(formatMessageRouteSummary([routed.row], "demo-agent"), /ignore\/normal\/msg/);
});
