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
  for (const anchor of ["workflow_dispatch:", "runs-on: [self-hosted, linux, codex-pro]", "group: codex-pro-account", "codex login status", "codex exec", "--model gpt-5.6-sol", "--sandbox read-only", "upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", "download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", "pull-requests: write"]) {
    if (!routine.includes(anchor)) errors.push(`routine-review.yml is missing: ${anchor}`);
  }
  if (/^\s*pull_request:/m.test(routine)) errors.push("Routine review must not run automatically on every pull request");
  if (/OPENAI_API_KEY|openai-api-key|openai\/codex-action/.test(routine)) errors.push("Routine review must use ChatGPT-managed auth, not API-key auth");
  if (!/review:[\s\S]*permissions:[\s\S]*contents: read[\s\S]*pull-requests: read/.test(routine)) errors.push("Review job must be read-only");
  if (!/publish:[\s\S]*permissions:[\s\S]*pull-requests: write/.test(routine)) errors.push("Only the publish job should receive pull-request write permission");
  const ci = content.get("ci.yml") ?? "";
  for (const anchor of ["pull_request:", "push:", "npm ci", "npm run check", "permissions:", "contents: read"]) {
    if (!ci.includes(anchor)) errors.push(`ci.yml is missing: ${anchor}`);
  }
  for (const file of ["deep-audit.yml", "review-eval.yml", "implementation-eval.yml"]) {
    const body = content.get(file) ?? "";
    if (!body.includes("workflow_dispatch:")) errors.push(`${file} must be manually dispatched`);
    if (!body.includes("runs-on: [self-hosted, linux, codex-pro]")) errors.push(`${file} must use the dedicated Pro runner`);
    if (!body.includes("group: codex-pro-account")) errors.push(`${file} must serialize ChatGPT account use`);
    if (!body.includes("codex login status") || !body.includes("codex exec")) errors.push(`${file} must use saved ChatGPT Codex auth`);
    if (/OPENAI_API_KEY|openai-api-key|openai\/codex-action/.test(body)) errors.push(`${file} must not require API-key auth`);
  }
  if (!(content.get("implementation-eval.yml") ?? "").includes("--sandbox workspace-write")) errors.push("Implementation eval must scope Codex writes to its workspace");
  return errors;
}

async function main() {
  const errors = await checkWorkflows();
  if (errors.length) return fail(`Workflow policy check failed:\n- ${errors.join("\n- ")}`);
  console.log("Workflow policy checks passed.");
}

if (isMain(import.meta.url)) await main();
