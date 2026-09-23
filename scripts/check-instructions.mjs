import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { assertExactKeys, fail, isMain, readJson, rootDir } from "./lib.mjs";

// Structural checks S1-S6 from docs/INSTRUCTION_RETENTION_CONTRACT.md.
// S6 (installer safety) lives in install-codex-global.mjs and its tests.

const files = ["G", "A"];
const bins = new Set(["meta", "duplicate", "behavioral"]);
const dispositions = new Set(["kept", "relocated", "merged", "removed"]);

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// Headings with byte offsets. Lines inside fenced code blocks are not headings.
export function parseSections(buffer) {
  const sections = [];
  let offset = 0;
  let fenced = false;
  for (const line of buffer.toString("utf8").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced) {
      const match = /^(#{1,4}) (.*)$/.exec(line);
      if (match) sections.push({ level: match[1].length, title: match[2], start: offset });
    }
    offset += Buffer.byteLength(line, "utf8") + 1;
  }
  const size = buffer.length;
  return sections.map((section, index) => ({ ...section, end: sections[index + 1]?.start ?? size }));
}

export function ruleIdFor(file, title) {
  if (file === "G") {
    const numbered = /^(\d+)\. /.exec(title);
    if (numbered) return `G${numbered[1]}`;
    if (title.startsWith("PR Review Protocol")) return "G-PRP";
    return `G-${slug(title)}`;
  }
  const numbered = /^(\d+[a-l]?(?:\.\d+)*)\.? /.exec(title);
  if (numbered) return `A-${numbered[1]}`;
  if (title.startsWith("AGENTS.md")) return "A-title";
  return `A-${slug(title)}`;
}

function slug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function injectedBytes(buffer, window) {
  return window === null ? buffer.length : Math.min(buffer.length, window);
}

function sectionMap(file, buffer) {
  const map = new Map();
  for (const section of parseSections(buffer)) map.set(ruleIdFor(file, section.title), section);
  return map;
}

export function validateInventoryShape(inventory) {
  const errors = [];
  assertExactKeys(inventory,
    ["schemaVersion", "windowBytes", "baseline", "candidate", "atlasReferences", "rules"], [],
    "inventory", errors);
  if (inventory.schemaVersion !== 1) errors.push("inventory.schemaVersion must be 1");
  if (inventory.windowBytes?.G !== null) errors.push("inventory.windowBytes.G must be null (injected in full)");
  if (!Number.isInteger(inventory.windowBytes?.A) || inventory.windowBytes.A <= 0) {
    errors.push("inventory.windowBytes.A must be a positive integer");
  }
  const ids = new Set();
  for (const [index, rule] of (inventory.rules ?? []).entries()) {
    const label = `rules[${index}]`;
    assertExactKeys(rule, ["id", "file", "heading", "bin", "disposition", "mustSee"],
      ["duplicateOf", "mergedInto", "relocatedTo"], label, errors);
    if (ids.has(rule.id)) errors.push(`${label}.id ${rule.id} is duplicated`);
    ids.add(rule.id);
    if (!files.includes(rule.file)) errors.push(`${label}.file is invalid`);
    if (!bins.has(rule.bin)) errors.push(`${label}.bin is invalid`);
    if (!dispositions.has(rule.disposition)) errors.push(`${label}.disposition is invalid`);
    if (typeof rule.mustSee !== "boolean") errors.push(`${label}.mustSee must be boolean`);
    if (rule.disposition === "removed" && rule.bin !== "meta") {
      errors.push(`${rule.id} is ${rule.bin} and cannot be removed (only meta text may be removed)`);
    }
    if (rule.disposition === "merged" && !inventory.rules.some((other) => other.id === rule.mergedInto && other.id !== rule.id)) {
      errors.push(`${rule.id} is merged but mergedInto does not name another rule`);
    }
    if (rule.disposition === "relocated" && (typeof rule.relocatedTo?.path !== "string" || typeof rule.relocatedTo?.pointer !== "string")) {
      errors.push(`${rule.id} is relocated but relocatedTo.path and relocatedTo.pointer are required`);
    }
    if (rule.bin === "duplicate" && !inventory.rules.some((other) => other.id === rule.duplicateOf)) {
      errors.push(`${rule.id} is a duplicate but duplicateOf does not name a rule`);
    }
  }
  return errors;
}

// S1 against the baseline: the inventory covers exactly the baseline sections.
export function checkBaselineCoverage(inventory, buffers) {
  const errors = [];
  for (const file of files) {
    const actual = new Set(sectionMap(file, buffers[file]).keys());
    const listed = new Set(inventory.rules.filter((rule) => rule.file === file).map((rule) => rule.id));
    for (const id of actual) if (!listed.has(id)) errors.push(`S1: baseline ${file} section ${id} has no inventory entry`);
    for (const id of listed) if (!actual.has(id)) errors.push(`S1: inventory rule ${id} is not a section of baseline ${file}`);
  }
  return errors;
}

// S1 against a candidate: kept rules exist, removed and merged rules do not,
// and every relocated rule leaves its pointer inside the injected window.
export function checkCandidateDispositions(inventory, buffers, only = files) {
  const errors = [];
  for (const file of only) {
    const sections = sectionMap(file, buffers[file]);
    const window = inventory.windowBytes[file];
    const injected = buffers[file].subarray(0, injectedBytes(buffers[file], window)).toString("utf8");
    for (const rule of inventory.rules.filter((item) => item.file === file)) {
      const present = sections.has(rule.id);
      if (rule.disposition === "kept" && !present) errors.push(`S1: kept rule ${rule.id} is missing from candidate ${file}`);
      if (["removed", "merged"].includes(rule.disposition) && present) {
        errors.push(`S1: ${rule.disposition} rule ${rule.id} still has a section in candidate ${file}`);
      }
      if (rule.disposition === "relocated" && !injected.includes(rule.relocatedTo.pointer)) {
        errors.push(`S1: relocated rule ${rule.id} has no pointer inside the injected window of ${file}`);
      }
    }
  }
  return errors;
}

// S2: must-see rules sit fully inside the injected window.
export function checkMustSee(inventory, buffers, only = files) {
  const findings = [];
  for (const file of only) {
    const window = inventory.windowBytes[file];
    if (window === null) continue;
    const sections = sectionMap(file, buffers[file]);
    for (const rule of inventory.rules.filter((item) => item.file === file && item.mustSee && item.disposition === "kept")) {
      const section = sections.get(rule.id);
      if (section && section.end > window) {
        findings.push(`S2: must-see ${rule.id} ends at byte ${section.end}, past the ${window}-byte window`);
      }
    }
  }
  return findings;
}

// S3: nothing in A past the window unless it was relocated.
export function checkTruncation(inventory, buffers, only = files) {
  if (!only.includes("A")) return [];
  const window = inventory.windowBytes.A;
  if (buffers.A.length <= window) return [];
  const byId = new Map(inventory.rules.map((rule) => [rule.id, rule]));
  const findings = [];
  for (const [id, section] of sectionMap("A", buffers.A)) {
    if (section.end <= window) continue;
    if (byId.get(id)?.disposition !== "relocated") {
      findings.push(`S3: ${id} is past the ${window}-byte window of A (${buffers.A.length} bytes) and is not relocated`);
    }
  }
  return findings;
}

// S4: Atlas section references resolve; pinned phrases hold.
export function checkAtlasReferences(references, bufferA) {
  const errors = [];
  const text = bufferA.toString("utf8");
  const compact = text.split(/\s+/).join(" ");
  const headings = new Set(parseSections(bufferA).map((section) => ruleIdFor("A", section.title).slice(2)));
  for (const reference of references.sectionIds) {
    if (!headings.has(reference.id)) {
      errors.push(`S4: Atlas cites AGENTS.md ${reference.id} (${reference.sources.join(", ")}) but no heading has that id`);
    }
  }
  for (const dangling of references.knownDangling) {
    if (headings.has(dangling.id)) {
      errors.push(`S4: ${dangling.id} now resolves; move it from knownDangling to sectionIds`);
    }
  }
  const contains = (phrase) => phrase.match === "whitespace" ? compact.includes(phrase.text) : text.includes(phrase.text);
  for (const phrase of references.requiredPhrases) {
    if (!contains(phrase)) errors.push(`S4: required phrase ${JSON.stringify(phrase.text)} is missing (${phrase.source})`);
  }
  for (const phrase of references.forbiddenPhrases) {
    if (contains(phrase)) errors.push(`S4: forbidden phrase ${JSON.stringify(phrase.text)} is present (${phrase.source})`);
  }
  return errors;
}

// S5: the candidate does not inject more than the baseline.
export function checkBudget(inventory, baseline, candidate) {
  const size = (buffers) => files.reduce((sum, file) => sum + injectedBytes(buffers[file], inventory.windowBytes[file]), 0);
  const before = size(baseline);
  const after = size(candidate);
  return {
    before,
    after,
    errors: after > before ? [`S5: candidate injects ${after} bytes, more than the baseline's ${before}`] : []
  };
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

export async function runChecks(root = rootDir) {
  const inventory = await readJson(path.join(root, "instructions", "rule-inventory.json"));
  const errors = validateInventoryShape(inventory);
  const report = [];
  if (errors.length) return { errors, report };

  const baseline = {};
  for (const file of files) {
    const record = inventory.baseline[file];
    baseline[file] = await readFile(path.join(root, record.path));
    if (sha256(baseline[file]) !== record.sha256) {
      errors.push(`baseline ${file} (${record.path}) does not match its recorded sha256; re-baseline before comparing results`);
    }
  }
  if (errors.length) return { errors, report };

  errors.push(...checkBaselineCoverage(inventory, baseline));
  errors.push(...checkAtlasReferences(inventory.atlasReferences, baseline.A));

  // Revision 4: check modes are per file. A file with a candidate is enforced;
  // a file without one is measured as its baseline and only reported.
  const candidate = {};
  for (const file of files) {
    const candidatePath = path.join(root, inventory.candidate[file]);
    if (await exists(candidatePath)) candidate[file] = await readFile(candidatePath);
  }
  const enforced = files.filter((file) => candidate[file]);
  const reported = files.filter((file) => !candidate[file]);
  const effective = Object.fromEntries(files.map((file) => [file, candidate[file] ?? baseline[file]]));

  errors.push(...checkCandidateDispositions(inventory, effective, enforced));
  errors.push(...checkMustSee(inventory, effective, enforced));
  errors.push(...checkTruncation(inventory, effective, enforced));
  if (candidate.A) errors.push(...checkAtlasReferences(inventory.atlasReferences, candidate.A));
  const budget = checkBudget(inventory, baseline, effective);
  errors.push(...budget.errors);
  report.push(enforced.length
    ? `candidate injects ${budget.after} bytes (baseline ${budget.before}); candidate files: ${enforced.join(", ")}`
    : `baseline injects ${budget.before} bytes (no candidate yet)`);
  // S2, S3, and S5 describe a candidate, so a file without one is reported, not enforced.
  for (const finding of [...checkMustSee(inventory, baseline, reported), ...checkTruncation(inventory, baseline, reported)]) {
    report.push(`baseline report: ${finding}`);
  }
  return { errors, report };
}

async function main() {
  const { errors, report } = await runChecks();
  for (const line of report) console.log(line);
  if (errors.length) fail(errors.join("\n"));
  else console.log("Instruction inventory checks passed.");
}

if (isMain(import.meta.url)) await main();
