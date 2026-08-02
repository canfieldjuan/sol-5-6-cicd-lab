import assert from "node:assert/strict";
import test from "node:test";
import { validateScenarios } from "../scripts/validate-scenarios.mjs";

test("all scenario manifests and fixtures are complete", async () => {
  assert.deepEqual(await validateScenarios(), []);
});
