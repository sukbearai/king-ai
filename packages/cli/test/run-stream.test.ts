import assert from "node:assert/strict";
import { test } from "node:test";
import {
  initialRunStreamState,
  reduceRunStream,
  renderRunStreamCard,
  renderRunStreamText
} from "../src/run-stream.js";

test("run stream state tracks reasoning, tools, message, and terminal status", () => {
  let state = initialRunStreamState();
  state = reduceRunStream(state, { type: "reasoning_delta", text: "thinking" });
  state = reduceRunStream(state, { type: "tool_started", id: "t1", name: "shell", input: "pnpm test" });
  state = reduceRunStream(state, { type: "tool_delta", id: "t1", text: "ok" });
  state = reduceRunStream(state, { type: "tool_done", id: "t1" });
  state = reduceRunStream(state, { type: "message_delta", text: "done" });
  state = reduceRunStream(state, { type: "done" });
  assert.equal(state.terminal, "done");
  assert.equal(state.tools[0]?.status, "done");
  assert.match(renderRunStreamText(state), /done/);
  const card = renderRunStreamCard(state);
  assert.equal(card.summary, "Completed");
  assert.equal(card.sections.some((section) => section.kind === "tool"), true);
});
