import { readFile } from "node:fs/promises";
import path from "node:path";
import { fail, isMain, rootDir } from "./lib.mjs";

const files = ["ci.yml", "routine-review.yml", "deep-audit.yml", "review-eval.yml", "implementation-eval.yml"];

export async function checkWorkflows() {
  const errors = [];
  const content = new Map();
  for (const file of files) {
    try { content.set(file, await readFile(path.join(rootDir, ".github", "workflows", file), "utf8")); }
    catch { errors.push(`Missing workflow: ${file}`); }
  }
  const routine = content.get("routine-review.yml") ?? "";
  for (const anchor of ["workflow_dispatch:", "openai/codex-action@52fe01ec70a42f454c9d2ebd47598f9fd6893d56", "model: gpt-5.6-sol", "permission-profile: \":read-only\"", "output-schema-file:", "drop-sudo", "upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02", "download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093", "pull-requests: write"]) {
    if (!routine.includes(anchor)) errors.push(`routine-review.yml is missing: ${anchor}`);
  }
  if (/^\s*pull_request:/m.test(routine)) errors.push("Routine review must not run automatically on every pull request");
  if (!/review:[\s\S]*permissions:[\s\S]*contents: read[\s\S]*pull-requests: read/.test(routine)) errors.push("Review job must be read-only");
  if (!/publish:[\s\S]*permissions:[\s\S]*pull-requests: write/.test(routine)) errors.push("Only the publish job should receive pull-request write permission");
  const ci = content.get("ci.yml") ?? "";
  for (const anchor of ["pull_request:", "push:", "npm ci", "npm run check", "permissions:", "contents: read"]) {
    if (!ci.includes(anchor)) errors.push(`ci.yml is missing: ${anchor}`);
  }
  for (const file of ["deep-audit.yml", "review-eval.yml", "implementation-eval.yml"]) {
    const body = content.get(file) ?? "";
    if (!body.includes("workflow_dispatch:")) errors.push(`${file} must be manually dispatched`);
    if (!body.includes("openai/codex-action@52fe01ec70a42f454c9d2ebd47598f9fd6893d56")) errors.push(`${file} must use the pinned Codex action`);
  }
  return errors;
}

async function main() {
  const errors = await checkWorkflows();
  if (errors.length) return fail(`Workflow policy check failed:\n- ${errors.join("\n- ")}`);
  console.log("Workflow policy checks passed.");
}

if (isMain(import.meta.url)) await main();
