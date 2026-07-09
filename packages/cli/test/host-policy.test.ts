import assert from "node:assert/strict";
import { test } from "node:test";
import { checkHostCommandPolicy, formatHostPolicyCheck, requiredHostConfirmation } from "../src/host-policy.js";

test("host policy allows read-only commands", () => {
  const check = checkHostCommandPolicy("status", false);
  assert.equal(check.decision, "allow");
  assert.equal(check.destructive, false);
  assert.match(formatHostPolicyCheck(check), /status: allowed/);
});

test("host policy requires confirmation for destructive commands", () => {
  const check = checkHostCommandPolicy("export", true);
  assert.equal(check.decision, "confirm_required");
  assert.equal(check.requiredConfirmation, "allow:export");
  assert.match(formatHostPolicyCheck(check), /confirmation required/);

  assert.equal(checkHostCommandPolicy("export", true, { confirmed: true }).decision, "allow");
  assert.equal(
    checkHostCommandPolicy("export", true, { confirmation: requiredHostConfirmation("export") }).decision,
    "allow",
  );
});
