import path from "node:path";
import { readFile } from "node:fs/promises";
import { fail, isMain, readJson } from "./lib.mjs";
import { validateReviewOutput } from "./validate-review-output.mjs";

export function normalizeFixtureFindingPath(findingPath) {
  return findingPath.startsWith("head/") ? findingPath.slice("head/".length) : findingPath;
}

export function gradeReview(scenario, output) {
  const errors = validateReviewOutput(output);
  if (errors.length) return errors;
  const expected = scenario.expected;
  if (output.status !== expected.status) errors.push(`Expected status ${expected.status}, received ${output.status}`);
  if (output.blockers.length > expected.maxBlockers) errors.push(`Expected at most ${expected.maxBlockers} blockers`);
  if (output.advisory.count > expected.maxAdvisory) errors.push(`Expected at most ${expected.maxAdvisory} advisory findings`);
  const ids = output.blockers.map((blocker) => blocker.ruleId);
  for (const rule of expected.requiredRuleIds) if (!ids.includes(rule)) errors.push(`Missing required rule: ${rule}`);
  for (const rule of expected.forbiddenRuleIds) if (ids.includes(rule)) errors.push(`Forbidden rule reported: ${rule}`);
  if (new Set(ids).size !== ids.length) errors.push("Duplicate root-cause rule IDs are not allowed");
  return errors;
}

async function main() {
  const [scenarioDirectory, outputFile] = process.argv.slice(2);
  if (!scenarioDirectory || !outputFile) return fail("Usage: node scripts/grade-review.mjs <scenario-directory> <review-output.json>");
  const scenario = await readJson(path.join(path.resolve(scenarioDirectory), "scenario.json"));
  const output = await readJson(path.resolve(outputFile));
  const errors = gradeReview(scenario, output);
  const expectedIndex = process.argv.indexOf("--expected-sha");
  if (expectedIndex >= 0 && output.reviewedHeadSha !== process.argv[expectedIndex + 1]) {
    errors.push("reviewedHeadSha does not match the evaluation checkout");
  }
  const headDirectory = path.join(path.resolve(scenarioDirectory), "head");
  for (const blocker of Array.isArray(output.blockers) ? output.blockers : []) {
    const findingPath = normalizeFixtureFindingPath(blocker.path);
    const target = path.resolve(headDirectory, findingPath);
    if (!target.startsWith(`${headDirectory}${path.sep}`)) {
      errors.push(`Finding path escapes the scenario head: ${blocker.path}`);
      continue;
    }
    try {
      const lines = (await readFile(target, "utf8")).split(/\r?\n/);
      if (blocker.line > lines.length) errors.push(`Finding line is outside ${blocker.path}: ${blocker.line}`);
    } catch {
      errors.push(`Finding path does not exist in the scenario head: ${blocker.path}`);
    }
  }
  if (errors.length) return fail(`Review scenario failed:\n- ${errors.join("\n- ")}`);
  console.log(`Review scenario '${scenario.id}' passed.`);
}

if (isMain(import.meta.url)) await main();
