import path from "node:path";
import { assertExactKeys, fail, isMain, readJson, rootDir } from "./lib.mjs";

export function validateContract(contract) {
  const errors = [];
  assertExactKeys(contract,
    ["schemaVersion", "repository", "reviewPolicy", "checks", "sensitiveFiles"],
    ["$schema"], "contract", errors);
  if (contract.schemaVersion !== 1) errors.push("contract.schemaVersion must be 1");

  const repository = contract.repository ?? {};
  assertExactKeys(repository, ["defaultBranch", "productionBranch", "minimumNodeVersion"], [], "repository", errors);
  if (!/^[A-Za-z0-9._/-]+$/.test(repository.defaultBranch ?? "")) errors.push("repository.defaultBranch is invalid");
  if (repository.productionBranch !== null && typeof repository.productionBranch !== "string") {
    errors.push("repository.productionBranch must be a string or null");
  }
  if (!Number.isInteger(repository.minimumNodeVersion) || repository.minimumNodeVersion < 20) {
    errors.push("repository.minimumNodeVersion must be an integer of at least 20");
  }

  const policy = contract.reviewPolicy ?? {};
  assertExactKeys(policy,
    ["routineMode", "blockingSeverities", "maxBlockers", "singleComment", "automaticReview", "deepAuditArtifactOnly"],
    [], "reviewPolicy", errors);
  if (policy.routineMode !== "bounded") errors.push("reviewPolicy.routineMode must be bounded");
  if (JSON.stringify(policy.blockingSeverities) !== JSON.stringify(["P0", "P1"])) {
    errors.push("reviewPolicy.blockingSeverities must be exactly [P0, P1]");
  }
  if (!Number.isInteger(policy.maxBlockers) || policy.maxBlockers < 1 || policy.maxBlockers > 5) {
    errors.push("reviewPolicy.maxBlockers must be between 1 and 5");
  }
  for (const key of ["singleComment", "automaticReview", "deepAuditArtifactOnly"]) {
    if (typeof policy[key] !== "boolean") errors.push(`reviewPolicy.${key} must be boolean`);
  }
  if (policy.singleComment !== true) errors.push("reviewPolicy.singleComment must stay enabled");
  if (policy.automaticReview !== false) errors.push("reviewPolicy.automaticReview must stay disabled");
  if (policy.deepAuditArtifactOnly !== true) errors.push("reviewPolicy.deepAuditArtifactOnly must stay enabled");

  if (!Array.isArray(contract.checks) || contract.checks.length === 0) {
    errors.push("checks must be a non-empty array");
  } else {
    const ids = new Set();
    for (const [index, check] of contract.checks.entries()) {
      const label = `checks[${index}]`;
      assertExactKeys(check, ["id", "title", "required", "command"], [], label, errors);
      if (!/^[a-z][a-z0-9-]*$/.test(check.id ?? "")) errors.push(`${label}.id is invalid`);
      if (ids.has(check.id)) errors.push(`${label}.id is duplicated`);
      ids.add(check.id);
      if (typeof check.title !== "string" || check.title.length === 0) errors.push(`${label}.title is required`);
      if (typeof check.required !== "boolean") errors.push(`${label}.required must be boolean`);
      if (!Array.isArray(check.command) || check.command.length === 0 || check.command.some((part) => typeof part !== "string" || !part)) {
        errors.push(`${label}.command must be a non-empty string array`);
      }
    }
  }

  const sensitive = contract.sensitiveFiles ?? {};
  assertExactKeys(sensitive, ["deployableRoots", "denyNamePatterns", "allowPaths"], [], "sensitiveFiles", errors);
  for (const key of ["deployableRoots", "denyNamePatterns", "allowPaths"]) {
    if (!Array.isArray(sensitive[key]) || sensitive[key].some((item) => typeof item !== "string")) {
      errors.push(`sensitiveFiles.${key} must be a string array`);
    }
  }
  for (const pattern of sensitive.denyNamePatterns ?? []) {
    try { new RegExp(pattern, "i"); } catch { errors.push(`Invalid sensitive-file regex: ${pattern}`); }
  }
  return errors;
}

async function main() {
  const file = path.join(rootDir, "ci-contract.json");
  const errors = validateContract(await readJson(file));
  if (errors.length) return fail(`Contract validation failed:\n- ${errors.join("\n- ")}`);
  console.log("Contract is valid.");
}

if (isMain(import.meta.url)) await main();
