import { readFile } from "node:fs/promises";
import path from "node:path";
import { fail, isMain, rootDir } from "./lib.mjs";

const requirements = {
  "routine-review.md": ["P0", "P1", "five", "Do not modify", "current head", "review-output.schema.json"],
  "deep-audit.md": ["Confirmed", "Contradicted", "Could-not-determine", "artifact"],
  "review-eval.md": ["scenario", "review-output.schema.json"],
  "implementation-eval.md": ["scenario", "definition of done"]
};

export async function checkPrompts() {
  const errors = [];
  for (const [name, anchors] of Object.entries(requirements)) {
    const file = path.join(rootDir, ".github", "codex", "prompts", name);
    let content = "";
    try { content = await readFile(file, "utf8"); }
    catch { errors.push(`Missing prompt: ${name}`); continue; }
    if (name === "routine-review.md" && Buffer.byteLength(content) > 8000) errors.push(`${name} exceeds 8 KB`);
    for (const anchor of anchors) {
      if (!content.toLowerCase().includes(anchor.toLowerCase())) errors.push(`${name} is missing boundary: ${anchor}`);
    }
  }
  const routine = await readFile(path.join(rootDir, ".github", "codex", "prompts", "routine-review.md"), "utf8").catch(() => "");
  if (/every evidence-backed gap/i.test(routine)) errors.push("routine-review.md contains an unbounded finding instruction");
  return errors;
}

async function main() {
  const errors = await checkPrompts();
  if (errors.length) return fail(`Prompt validation failed:\n- ${errors.join("\n- ")}`);
  console.log("Prompt boundaries are valid.");
}

if (isMain(import.meta.url)) await main();
