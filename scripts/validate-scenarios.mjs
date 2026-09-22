import path from "node:path";
import { access } from "node:fs/promises";
import { assertExactKeys, fail, isMain, readJson, relativeFromRoot, rootDir, walkFiles } from "./lib.mjs";

function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export async function validateScenario(file) {
  const errors = [];
  const scenario = await readJson(file);
  const directory = path.dirname(file);
  const lane = path.basename(path.dirname(directory));
  const folderId = path.basename(directory);
  assertExactKeys(scenario, ["schemaVersion", "id", "lane", "description", "expected"], ["$schema"], folderId, errors);
  if (scenario.schemaVersion !== 1) errors.push(`${folderId}.schemaVersion must be 1`);
  if (!/^[a-z][a-z0-9-]*$/.test(scenario.id ?? "")) errors.push(`${folderId}.id is invalid`);
  if (scenario.id !== folderId) errors.push(`${folderId}.id must match its directory`);
  if (!["review", "implementation", "instructions"].includes(scenario.lane)) errors.push(`${folderId}.lane is invalid`);
  if (scenario.lane !== lane) errors.push(`${folderId}.lane must match its parent directory`);
  if (typeof scenario.description !== "string" || !scenario.description.trim()) errors.push(`${folderId}.description is required`);

  if (scenario.lane === "review") {
    assertExactKeys(scenario.expected,
      ["status", "requiredRuleIds", "forbiddenRuleIds", "maxBlockers", "maxAdvisory"], [],
      `${folderId}.expected`, errors);
    if (!["pass", "block"].includes(scenario.expected?.status)) errors.push(`${folderId}.expected.status is invalid`);
    for (const key of ["requiredRuleIds", "forbiddenRuleIds"]) {
      if (!stringArray(scenario.expected?.[key])) errors.push(`${folderId}.expected.${key} must be a string array`);
    }
    for (const key of ["maxBlockers", "maxAdvisory"]) {
      if (!Number.isInteger(scenario.expected?.[key]) || scenario.expected[key] < 0) {
        errors.push(`${folderId}.expected.${key} must be a non-negative integer`);
      }
    }
    for (const required of ["base", "head", "change.patch", "task.md"]) {
      try { await access(path.join(directory, required)); } catch { errors.push(`${folderId} is missing ${required}`); }
    }
  }

  if (scenario.lane === "implementation") {
    assertExactKeys(scenario.expected,
      ["commands", "allowedPaths", "forbiddenPaths", "maxChangedFiles"], [],
      `${folderId}.expected`, errors);
    const commands = scenario.expected?.commands;
    if (!Array.isArray(commands) || commands.length === 0 || commands.some((command) => !stringArray(command) || command.length === 0)) {
      errors.push(`${folderId}.expected.commands must be a non-empty array of string arrays`);
    }
    for (const key of ["allowedPaths", "forbiddenPaths"]) {
      if (!stringArray(scenario.expected?.[key])) errors.push(`${folderId}.expected.${key} must be a string array`);
    }
    if (!Number.isInteger(scenario.expected?.maxChangedFiles) || scenario.expected.maxChangedFiles < 1) {
      errors.push(`${folderId}.expected.maxChangedFiles must be a positive integer`);
    }
    for (const required of ["workspace", "task.md"]) {
      try { await access(path.join(directory, required)); } catch { errors.push(`${folderId} is missing ${required}`); }
    }
  }
  if (scenario.lane === "instructions") {
    const expected = scenario.expected;
    assertExactKeys(expected,
      ["rules", "forbiddenCommands", "requiredCommands", "forbiddenOutputs", "afterFailure", "finalMessage", "shimCalls", "evidenceBackedValues"], [],
      `${folderId}.expected`, errors);
    const inventory = await readJson(path.join(rootDir, "instructions", "rule-inventory.json"));
    const globalRules = new Set(inventory.rules.filter((rule) => rule.file === "G").map((rule) => rule.id));
    if (!stringArray(expected?.rules) || expected.rules.length === 0) errors.push(`${folderId}.expected.rules must name at least one rule`);
    for (const id of expected?.rules ?? []) if (!globalRules.has(id)) errors.push(`${folderId}.expected.rules: ${id} is not a global rule in the inventory`);
    const patterns = [];
    for (const key of ["forbiddenCommands", "requiredCommands", "forbiddenOutputs"]) {
      if (!stringArray(expected?.[key])) errors.push(`${folderId}.expected.${key} must be a string array`);
      else patterns.push(...expected[key]);
    }
    if (expected?.afterFailure !== null) {
      assertExactKeys(expected?.afterFailure, ["trigger", "forbidden"], [], `${folderId}.expected.afterFailure`, errors);
      if (typeof expected?.afterFailure?.trigger === "string") patterns.push(expected.afterFailure.trigger);
      if (stringArray(expected?.afterFailure?.forbidden)) patterns.push(...expected.afterFailure.forbidden);
    }
    for (const [key, sub] of [["finalMessage", ["mustMatch", "mustNotMatch"]], ["shimCalls", ["required", "forbidden"]]]) {
      assertExactKeys(expected?.[key], sub, [], `${folderId}.expected.${key}`, errors);
      for (const item of sub) {
        if (!stringArray(expected?.[key]?.[item])) errors.push(`${folderId}.expected.${key}.${item} must be a string array`);
        else patterns.push(...expected[key][item]);
      }
    }
    for (const pattern of patterns) {
      try { new RegExp(pattern); } catch { errors.push(`${folderId}: pattern /${pattern}/ does not compile`); }
    }
    if (typeof expected?.evidenceBackedValues !== "boolean") errors.push(`${folderId}.expected.evidenceBackedValues must be boolean`);
    for (const required of ["task.md", "setup.sh", "fixtures/pass.jsonl", "fixtures/fail.jsonl"]) {
      try { await access(path.join(directory, required)); } catch { errors.push(`${folderId} is missing ${required}`); }
    }
  }
  return errors;
}

export async function validateScenarios() {
  const files = (await walkFiles(path.join(rootDir, "scenarios"))).filter((file) => path.basename(file) === "scenario.json");
  if (files.length === 0) return ["No scenarios found"];
  const errors = [];
  for (const file of files) {
    try { errors.push(...await validateScenario(file)); }
    catch (error) { errors.push(`${relativeFromRoot(file)}: ${error.message}`); }
  }
  return errors;
}

async function main() {
  const errors = await validateScenarios();
  if (errors.length) return fail(`Scenario validation failed:\n- ${errors.join("\n- ")}`);
  console.log("Scenario manifests are valid.");
}

if (isMain(import.meta.url)) await main();
