import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readJson, rootDir } from "../scripts/lib.mjs";
import { validateContract } from "../scripts/validate-contract.mjs";

test("the checked-in contract is valid", async () => {
  const contract = await readJson(path.join(rootDir, "ci-contract.json"));
  assert.deepEqual(validateContract(contract), []);
});

test("the contract rejects automatic routine review", async () => {
  const contract = structuredClone(await readJson(path.join(rootDir, "ci-contract.json")));
  contract.reviewPolicy.automaticReview = true;
  assert.match(validateContract(contract).join("\n"), /automaticReview must stay disabled/);
});

test("the contract rejects an unbounded blocker budget", async () => {
  const contract = structuredClone(await readJson(path.join(rootDir, "ci-contract.json")));
  contract.reviewPolicy.maxBlockers = 20;
  assert.match(validateContract(contract).join("\n"), /between 1 and 5/);
});

test("the contract rejects API billing as the default agent auth", async () => {
  const contract = structuredClone(await readJson(path.join(rootDir, "ci-contract.json")));
  contract.agentRuntime.authMode = "api-key";
  assert.match(validateContract(contract).join("\n"), /must be chatgpt-managed/);
});
