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

test("run stream records attempt retries separately from final terminal state", () => {
  let state = initialRunStreamState();
  state = reduceRunStream(state, { type: "attempt", attempt: 1, status: "failed_retrying", message: "no output" });
  assert.equal(state.terminal, "running");
  assert.equal(state.attempts?.[0]?.status, "failed_retrying");

  state = reduceRunStream(state, { type: "attempt", attempt: 2, status: "failed_final", message: "no output" });
  state = reduceRunStream(state, { type: "error", message: "no output" });

  assert.equal(state.terminal, "error");
  assert.match(renderRunStreamText(state), /attempt failed, retrying: #1/);
  const card = renderRunStreamCard(state);
  const attempts = card.sections.find((section) => section.title === "Attempts");
  assert.equal(attempts?.kind, "status");
  assert.match(attempts?.body ?? "", /#1 failed, retrying/);
  assert.match(attempts?.body ?? "", /#2 failed/);
});
