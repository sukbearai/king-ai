import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgentConfig } from "../src/agent-config-validation.js";

test("validateAgentConfig warns when idle_cached is hosted by codex", () => {
  const warnings = validateAgentConfig(
    {
      id: "demo",
      name: "Demo",
      engine: "codex",
      lifecycle: "idle_cached",
    },
    "codex",
    ["codex"],
  );

  assert.deepEqual(
    warnings.map((warning) => warning.code),
    ["idle-cached-without-resume"],
  );
  assert.match(warnings[0]?.summary ?? "", /engine-specific/);
  assert.match(warnings[0]?.detail ?? "", /app-server thread/);
});

test("validateAgentConfig warns about missing preferred engines and unknown lifecycle", () => {
  const warnings = validateAgentConfig(
    {
      id: "demo",
      name: "Demo",
      engine: "claude",
      lifecycle: "surprise" as never,
    },
    "codex",
    ["codex"],
  );

  assert.deepEqual(
    warnings.map((warning) => warning.code),
    ["unknown-lifecycle", "missing-preferred-engine"],
  );
  assert.match(warnings[1]?.detail ?? "", /codex/);
});

test("validateAgentConfig warns when reasoning effort is configured for non-grok engines", () => {
  const warnings = validateAgentConfig(
    {
      id: "demo",
      name: "Demo",
      engine: "codex",
      reasoningEffort: "low",
    },
    "codex",
    ["codex", "grok"],
  );

  assert.deepEqual(
    warnings.map((warning) => warning.code),
    ["reasoning-effort-ignored"],
  );
  assert.match(warnings[0]?.detail ?? "", /--reasoning-effort/);
  assert.deepEqual(
    validateAgentConfig(
      {
        id: "chat",
        name: "Chat",
        engine: "grok",
        reasoningEffort: "low",
      },
      "grok",
      ["grok"],
    ),
    [],
  );
});
