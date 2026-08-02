import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fail, isMain, readJson } from "./lib.mjs";
import { validateReviewOutput } from "./validate-review-output.mjs";

export const marker = "<!-- sol-5-6-bounded-review -->";

function clean(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

export function renderReviewComment(output) {
  const lines = [marker, "## Bounded Codex review", "", clean(output.summary), ""];
  if (output.blockers.length === 0) lines.push("**Blocking findings:** None", "");
  else {
    lines.push(`**Blocking findings (${output.blockers.length}/5):**`, "");
    for (const finding of output.blockers) {
      lines.push(`### ${finding.severity}: ${clean(finding.title)}`);
      lines.push(`- Rule: \`${finding.ruleId}\``);
      lines.push(`- Location: \`${clean(finding.path)}:${finding.line}\``);
      lines.push(`- Trigger: ${clean(finding.trigger)}`);
      lines.push(`- Impact: ${clean(finding.impact)}`);
      lines.push(`- Evidence: ${clean(finding.evidence)}`);
      lines.push(`- Required remediation: ${clean(finding.remediation)}`, "");
    }
  }
  lines.push(`**Advisory:** ${output.advisory.count}`);
  if (output.advisory.themes.length) lines.push(`Themes: ${output.advisory.themes.map(clean).join(", ")}`);
  lines.push("", `<sub>Reviewed head \`${output.reviewedHeadSha}\`. This comment is replaced on the next requested review.</sub>`, "");
  return lines.join("\n");
}

async function main() {
  const [inputFile, outputFile] = process.argv.slice(2);
  if (!inputFile || !outputFile) return fail("Usage: node scripts/render-review-comment.mjs <review-output.json> <comment.md>");
  const output = await readJson(path.resolve(inputFile));
  const errors = validateReviewOutput(output);
  if (errors.length) return fail(`Cannot render invalid output:\n- ${errors.join("\n- ")}`);
  await writeFile(path.resolve(outputFile), renderReviewComment(output), "utf8");
  console.log(`Rendered ${outputFile}.`);
}

if (isMain(import.meta.url)) await main();
