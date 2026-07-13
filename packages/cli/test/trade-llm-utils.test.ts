import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachExecFileOutput,
  buildCodexArgs,
  extractJsonFromText,
  resetAgentBackendBlocks,
  resolveAgentBackendOrder,
  runAgent,
  salvageAgentErrorStdout,
  summarizeAgentError,
} from "../src/trade/llm-utils.js";

test("extractJsonFromText parses fenced JSON array", () => {
  const parsed = extractJsonFromText('prefix\n```json\n[{"a":1}]\n```\nsuffix');
  assert.deepEqual(parsed, [{ a: 1 }]);
});

test("extractJsonFromText parses bare object", () => {
  const parsed = extractJsonFromText('answer {"ok":true} done');
  assert.deepEqual(parsed, { ok: true });
});

test("extractJsonFromText keeps enclosing object when it contains arrays", () => {
  const celebrity = extractJsonFromText(
    '{"is_alpha":false,"alpha_type":"none","confidence":0.05,"reason":"无标的","entities":[]}',
  );
  assert.deepEqual(celebrity, {
    is_alpha: false,
    alpha_type: "none",
    confidence: 0.05,
    reason: "无标的",
    entities: [],
  });

  const withProse = extractJsonFromText('结论: {"is_alpha":true,"entities":["DOGE"]} 完');
  assert.deepEqual(withProse, { is_alpha: true, entities: ["DOGE"] });
});

test("extractJsonFromText still returns top-level arrays", () => {
  const parsed = extractJsonFromText('[{"idx":0,"impact":"medium"},{"idx":1,"impact":"low"}]');
  assert.deepEqual(parsed, [
    { idx: 0, impact: "medium" },
    { idx: 1, impact: "low" },
  ]);

  const prefixed = extractJsonFromText('classified:\n[{"idx":2}]');
  assert.deepEqual(prefixed, [{ idx: 2 }]);
});

test("resolveAgentBackendOrder inherits defaults and keeps fallback order unique", () => {
  assert.deepEqual(resolveAgentBackendOrder({ default_backend: "codex" }, "   "), ["codex", "grok", "claude"]);
  assert.deepEqual(resolveAgentBackendOrder({ default_backend: "codex" }, undefined), ["codex", "grok", "claude"]);
  assert.deepEqual(resolveAgentBackendOrder({ default_backend: "codex" }, "claude"), ["claude", "grok", "codex"]);
  assert.deepEqual(resolveAgentBackendOrder({ provider: "claude" }, ""), ["claude", "grok", "codex"]);
  const order = resolveAgentBackendOrder({ default_backend: "codex" }, "codex");
  assert.equal(new Set(order).size, order.length);
});

test("buildCodexArgs includes the read-only repository-check bypass", () => {
  const args = buildCodexArgs("classify this", "/tmp/last-message.txt");
  assert.ok(args.includes("--skip-git-repo-check"));
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("read-only"));
  assert.ok(args.includes("--output-last-message"));
  assert.ok(args.includes("--ephemeral"));
});

test("salvageAgentErrorStdout recovers JSON stdout from exec errors", () => {
  const withJson = new Error("Command failed: grok");
  (withJson as Error & { stdout: string }).stdout = 'noise {"is_alpha":false,"entities":[]} trailing';
  assert.equal(salvageAgentErrorStdout(withJson), 'noise {"is_alpha":false,"entities":[]} trailing');

  const bufJson = new Error("Command failed: grok");
  (bufJson as Error & { stdout: Buffer }).stdout = Buffer.from('{"ok":true}');
  assert.equal(salvageAgentErrorStdout(bufJson), '{"ok":true}');

  const noJson = new Error("Command failed: grok");
  (noJson as Error & { stdout: string }).stdout = "plain text answer without braces";
  assert.equal(salvageAgentErrorStdout(noJson), "");

  const empty = new Error("Command failed: grok");
  (empty as Error & { stdout: string }).stdout = "   ";
  assert.equal(salvageAgentErrorStdout(empty), "");

  assert.equal(salvageAgentErrorStdout(new Error("no stdout")), "");
  assert.equal(salvageAgentErrorStdout("string err"), "");
});

test("summarizeAgentError redacts long prompts and classifies quota/auth failures", () => {
  const prompt = "你是一个加密货币事件交易分析师。".repeat(80);
  const quota = summarizeAgentError(
    new Error(`Command failed: grok -p ${prompt}
personal-team-blocked:spending-limit: You have run out of credits or need a Grok subscription.`),
  );
  assert.equal(quota, "quota blocked: Grok credits or subscription required");

  const auth = summarizeAgentError(
    new Error("Failed to authenticate. API Error: 401 Invalid authentication credentials"),
  );
  assert.equal(auth, "auth failed: invalid or expired credentials");

  const stdoutAuth = new Error("Command failed: claude --print");
  (stdoutAuth as Error & { stdout: string }).stdout =
    "Failed to authenticate. API Error: 401 Invalid authentication credentials";
  (stdoutAuth as Error & { stderr: string }).stderr = "Warning: no stdin data received";
  assert.equal(summarizeAgentError(stdoutAuth), "auth failed: invalid or expired credentials");

  const generic = summarizeAgentError(new Error(`Command failed: agent ${prompt}`));
  assert.ok(generic.length <= 1000);
  assert.doesNotMatch(generic, /交易分析师。交易分析师。交易分析师/);

  const detailed = new Error("Command failed: codex exec prompt");
  (detailed as Error & { code: number; stderr: string; stdout: string }).code = 1;
  (detailed as Error & { stderr: string }).stderr = "first stderr line\nsecond stderr line";
  (detailed as Error & { stdout: string }).stdout = "partial answer";
  const detailSummary = summarizeAgentError(detailed);
  assert.match(detailSummary, /exit=1/);
  assert.match(detailSummary, /stderr=first stderr line second stderr line/);
  assert.match(detailSummary, /stdout=partial answer/);
});

test("exec failure output is attached and summaries do not retain command prompts", () => {
  const attached = attachExecFileOutput(
    new Error("Command failed: codex -p TOP_SECRET_PROMPT"),
    "partial answer",
    "stderr detail",
  );
  assert.equal((attached as Error & { stdout: string }).stdout, "partial answer");
  assert.equal((attached as Error & { stderr: string }).stderr, "stderr detail");
  const summary = summarizeAgentError(attached);
  assert.match(summary, /stderr=stderr detail/);
  assert.match(summary, /stdout=partial answer/);
  assert.doesNotMatch(summary, /TOP_SECRET_PROMPT/);
});

test("runAgent required mode reports backend exhaustion while default mode falls back", async () => {
  resetAgentBackendBlocks();
  const config = { llm: { default_backend: "codex" } };
  const fakeRunner = async (name: string): Promise<string> => {
    if (name === "grok") {
      const err = new Error("backend failed");
      (err as Error & { stderr: string }).stderr = "Failed to authenticate";
      throw err;
    }
    return "";
  };
  await assert.rejects(
    () =>
      runAgent("classify", {
        config,
        task: "celebrity_extract",
        required: true,
        backendRunner: fakeRunner,
      }),
    /required agent task celebrity_extract unavailable: .*codex=.*grok=.*claude=/,
  );

  resetAgentBackendBlocks();
  const emptyDefault = await runAgent("classify", {
    config,
    task: "celebrity_extract",
    backendRunner: fakeRunner,
  });
  assert.equal(emptyDefault, "");

  resetAgentBackendBlocks();
  const fallback = await runAgent("classify", {
    config,
    task: "celebrity_extract",
    backendRunner: async (name: string) => (name === "grok" ? "fallback" : ""),
  });
  assert.equal(fallback, "fallback");
  resetAgentBackendBlocks();
});

test("runAgent skips temporarily blocked auth/quota backends", async () => {
  resetAgentBackendBlocks();
  const calls: string[] = [];
  const fakeRunner = async (name: string): Promise<string> => {
    calls.push(name);
    if (name === "grok") {
      const err = new Error("quota");
      (err as Error & { stderr: string }).stderr = "personal-team-blocked:spending-limit";
      throw err;
    }
    return "ok";
  };
  const options = {
    config: { llm: { default_backend: "grok" } },
    timeoutMs: 5000,
    backendRunner: fakeRunner,
  };
  const first = await runAgent("hello", options);
  const second = await runAgent("hello", options);
  assert.equal(first, "ok");
  assert.equal(second, "ok");
  assert.deepEqual(calls, ["grok", "claude", "claude"]);
  resetAgentBackendBlocks();
});
