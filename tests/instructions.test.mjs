import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readJson, rootDir } from "../scripts/lib.mjs";
import {
  checkAtlasReferences, checkBaselineCoverage, checkBudget, checkCandidateDispositions,
  checkMustSee, checkTruncation, parseSections, ruleIdFor, runChecks, sha256, validateInventoryShape
} from "../scripts/check-instructions.mjs";
import { decide, install } from "../scripts/install-codex-global.mjs";

const inventoryPath = path.join(rootDir, "instructions", "rule-inventory.json");
const loadInventory = async () => structuredClone(await readJson(inventoryPath));
const buf = (text) => Buffer.from(text, "utf8");

function miniInventory(rules, windowA = 40) {
  return { windowBytes: { G: null, A: windowA }, rules };
}
const rule = (id, file, extra = {}) => ({ id, file, heading: id, bin: "behavioral", disposition: "kept", mustSee: false, ...extra });

test("the checked-in inventory and candidate pass the enforced checks", async () => {
  const { errors, report } = await runChecks();
  assert.deepEqual(errors, []);
  assert.ok(report.some((line) => /^candidate injects \d+ bytes \(baseline 61232\); candidate files: G$/.test(line)));
});

test("the baseline report names the known truncation defect", async () => {
  const { report } = await runChecks();
  assert.ok(report.some((line) => line.includes("S2: must-see A-3k.2") && line.includes("past the 32768-byte window")));
  assert.ok(report.some((line) => line.includes("S3: A-3l is past")));
});

test("headings inside fenced code blocks are not sections", () => {
  const sections = parseSections(buf("# Title\n```\n# not a heading\n```\n## Real\nbody\n"));
  assert.deepEqual(sections.map((section) => section.title), ["Title", "Real"]);
  assert.equal(sections[1].end, Buffer.byteLength("# Title\n```\n# not a heading\n```\n## Real\nbody\n"));
});

test("section offsets count bytes, not characters", () => {
  const sections = parseSections(buf("# é—x\n## Next\n"));
  assert.equal(sections[1].start, Buffer.byteLength("# é—x\n"));
});

test("rule ids come from section numbers or slugs", () => {
  assert.equal(ruleIdFor("G", "7. Merge is the model's"), "G7");
  assert.equal(ruleIdFor("G", "PR Review Protocol (standing, 2026-07-04)"), "G-PRP");
  assert.equal(ruleIdFor("G", "How to install"), "G-how-to-install");
  assert.equal(ruleIdFor("A", "3k.2. Convergence circuit-breaker"), "A-3k.2");
  assert.equal(ruleIdFor("A", "1a. Plan doc"), "A-1a");
  assert.equal(ruleIdFor("A", "Review guidelines"), "A-review-guidelines");
});

test("S1 fails when a baseline section has no inventory entry, or an entry has no section", async () => {
  const inventory = await loadInventory();
  const baseline = {
    G: await readFile(path.join(rootDir, inventory.baseline.G.path)),
    A: await readFile(path.join(rootDir, inventory.baseline.A.path))
  };
  const missing = { ...inventory, rules: inventory.rules.filter((item) => item.id !== "G4") };
  assert.match(checkBaselineCoverage(missing, baseline).join("\n"), /section G4 has no inventory entry/);
  const extra = { ...inventory, rules: [...inventory.rules, rule("A-9z", "A")] };
  assert.match(checkBaselineCoverage(extra, baseline).join("\n"), /A-9z is not a section of baseline A/);
});

test("S1 forbids removing a behavioral rule and dangling merge targets", async () => {
  const inventory = await loadInventory();
  inventory.rules.find((item) => item.id === "G4").disposition = "removed";
  assert.match(validateInventoryShape(inventory).join("\n"), /G4 is behavioral and cannot be removed/);

  const merged = await loadInventory();
  Object.assign(merged.rules.find((item) => item.id === "G11"), { disposition: "merged", mergedInto: "G-nope" });
  assert.match(validateInventoryShape(merged).join("\n"), /G11 is merged but mergedInto does not name another rule/);

  const meta = await loadInventory();
  meta.rules.find((item) => item.id === "G-how-to-install").disposition = "removed";
  assert.deepEqual(validateInventoryShape(meta), []);
});

test("S1 candidate mode checks each disposition", () => {
  const inventory = miniInventory([
    rule("G1", "G"),
    rule("G2", "G", { disposition: "removed", bin: "meta" }),
    rule("A-1a", "A", { disposition: "relocated", relocatedTo: { path: "docs/x.md", pointer: "read docs/x.md" } })
  ], 100);
  const good = { G: buf("### 1. keep\n"), A: buf("# T\nread docs/x.md before plans\n") };
  assert.deepEqual(checkCandidateDispositions(inventory, good), []);

  const bad = { G: buf("### 2. should be gone\n"), A: buf("# T\n" + "x".repeat(200) + "read docs/x.md\n") };
  const errors = checkCandidateDispositions(inventory, bad).join("\n");
  assert.match(errors, /kept rule G1 is missing/);
  assert.match(errors, /removed rule G2 still has a section/);
  assert.match(errors, /relocated rule A-1a has no pointer inside the injected window/);
});

test("S2 flags a must-see rule that ends past the window, and passes one inside it", () => {
  const inventory = miniInventory([rule("A-1a", "A", { mustSee: true })], 30);
  assert.deepEqual(checkMustSee(inventory, { G: buf(""), A: buf("### 1a. short\nok\n") }), []);
  const findings = checkMustSee(inventory, { G: buf(""), A: buf("### 1a. long\n" + "y".repeat(40) + "\n") });
  assert.match(findings.join("\n"), /must-see A-1a ends at byte \d+, past the 30-byte window/);
});

test("S2 boundary: a section ending exactly at the window passes, one byte more fails", () => {
  const text = "### 1a. edge\n";
  const exact = miniInventory([rule("A-1a", "A", { mustSee: true })], Buffer.byteLength(text));
  assert.deepEqual(checkMustSee(exact, { G: buf(""), A: buf(text) }), []);
  const over = miniInventory([rule("A-1a", "A", { mustSee: true })], Buffer.byteLength(text) - 1);
  assert.equal(checkMustSee(over, { G: buf(""), A: buf(text) }).length, 1);
});

test("S3 allows an oversized A only when everything past the window is relocated", () => {
  const text = "### 1a. first\nshort\n### 1b. second\n" + "z".repeat(50) + "\n";
  const kept = miniInventory([rule("A-1a", "A"), rule("A-1b", "A")], 30);
  assert.match(checkTruncation(kept, { A: buf(text) }).join("\n"), /A-1b is past the 30-byte window/);
  const moved = miniInventory([rule("A-1a", "A"), rule("A-1b", "A", { disposition: "relocated", relocatedTo: { path: "d", pointer: "p" } })], 30);
  assert.deepEqual(checkTruncation(moved, { A: buf(text) }), []);
  assert.deepEqual(checkTruncation(kept, { A: buf("### 1a. fits\n") }), []);
});

test("S4 fails on a renamed cited section, a lost phrase, a forbidden phrase, and a stale dangling entry", async () => {
  const { atlasReferences } = await loadInventory();
  const baselineA = await readFile(path.join(rootDir, "instructions", "atlas", "AGENTS.snapshot.md"));
  assert.deepEqual(checkAtlasReferences(atlasReferences, baselineA), []);

  const renamed = buf(baselineA.toString("utf8").replace("### 3k.2. Convergence", "### 3k.9. Convergence"));
  assert.match(checkAtlasReferences(atlasReferences, renamed).join("\n"), /cites AGENTS.md 3k.2 .* no heading has that id/);

  const lost = buf(baselineA.toString("utf8").replaceAll("WAIVE_SPECULATIVE", "WAIVE_GUESS"));
  assert.match(checkAtlasReferences(atlasReferences, lost).join("\n"), /required phrase "WAIVE_SPECULATIVE" is missing/);

  const forbidden = buf(baselineA.toString("utf8") + "\nuse claude-review here\n");
  assert.match(checkAtlasReferences(atlasReferences, forbidden).join("\n"), /forbidden phrase "claude-review" is present/);

  const resolved = buf(baselineA.toString("utf8") + "\n#### 4a.1. Now real\n");
  assert.match(checkAtlasReferences(atlasReferences, resolved).join("\n"), /4a\.1 now resolves/);
});

test("S4 exact phrases keep their line breaks; whitespace phrases do not", () => {
  const references = {
    sectionIds: [], knownDangling: [], forbiddenPhrases: [],
    requiredPhrases: [
      { text: "Do not retroactively\nre-disposition", match: "exact", source: "t" },
      { text: "evidence-gated mechanism", match: "whitespace", source: "t" }
    ]
  };
  assert.deepEqual(checkAtlasReferences(references, buf("Do not retroactively\nre-disposition\nevidence-gated\n   mechanism")), []);
  assert.match(checkAtlasReferences(references, buf("Do not retroactively re-disposition evidence-gated mechanism")).join("\n"),
    /required phrase "Do not retroactively\\nre-disposition" is missing/);
});

test("S5 fails when the candidate injects more than the baseline, counting only A's window", () => {
  const inventory = miniInventory([], 10);
  const baseline = { G: buf("12345"), A: buf("x".repeat(100)) };
  assert.deepEqual(checkBudget(inventory, baseline, { G: buf("12345"), A: buf("y".repeat(500)) }).errors, []);
  assert.match(checkBudget(inventory, baseline, { G: buf("123456"), A: buf("y".repeat(50)) }).errors.join(""), /injects 16 bytes, more than the baseline.s 15/);
});

test("a baseline hash mismatch stops the checks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "instr-"));
  try {
    const inventory = await loadInventory();
    for (const file of ["G", "A"]) {
      const target = path.join(root, inventory.baseline[file].path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await readFile(path.join(rootDir, inventory.baseline[file].path)));
    }
    await mkdir(path.join(root, "instructions"), { recursive: true });
    await writeFile(path.join(root, "instructions", "rule-inventory.json"), JSON.stringify(inventory));
    await writeFile(path.join(root, inventory.baseline.G.path), "edited\n");
    const { errors } = await runChecks(root);
    assert.match(errors.join("\n"), /baseline G .* does not match its recorded sha256/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function candidateRoot(candidateG) {
  const root = await mkdtemp(path.join(os.tmpdir(), "instr-"));
  // Baseline-style inventory: every rule kept, so only the mode logic is under test.
  const inventory = await loadInventory();
  for (const item of inventory.rules) { item.disposition = "kept"; delete item.mergedInto; delete item.relocatedTo; }
  for (const file of ["G", "A"]) {
    const target = path.join(root, inventory.baseline[file].path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(path.join(rootDir, inventory.baseline[file].path)));
  }
  await writeFile(path.join(root, "instructions", "rule-inventory.json"), JSON.stringify(inventory));
  await mkdir(path.join(root, path.dirname(inventory.candidate.G)), { recursive: true });
  await writeFile(path.join(root, inventory.candidate.G), candidateG);
  return { root, inventory };
}

test("revision 4: a G-only candidate is enforced on G while A stays in baseline-report mode", async () => {
  const baselineG = await readFile(path.join(rootDir, "instructions", "codex-global", "AGENTS.md"));
  const same = await candidateRoot(baselineG);
  try {
    const { errors, report } = await runChecks(same.root);
    assert.deepEqual(errors, [], "the unchanged G as a candidate passes, and A's truncation is not enforced");
    assert.ok(report.some((line) => line.includes("candidate files: G")));
    assert.ok(report.some((line) => line.startsWith("baseline report: S3: A-3l is past")), "A is still reported");
  } finally { await rm(same.root, { recursive: true, force: true }); }

  const bad = await candidateRoot("# only a title\n");
  try {
    const { errors } = await runChecks(bad.root);
    assert.match(errors.join("\n"), /S1: kept rule G1 is missing from candidate G/, "G's dispositions are enforced");
    assert.doesNotMatch(errors.join("\n"), /A-3l|candidate A/, "A's dispositions are not checked without an A candidate");
  } finally { await rm(bad.root, { recursive: true, force: true }); }

  const bigger = await candidateRoot(Buffer.concat([baselineG, Buffer.from("\nmore text\n")]));
  try {
    const { errors } = await runChecks(bigger.root);
    assert.match(errors.join("\n"), /S5: candidate injects \d+ bytes, more than the baseline/, "budget counts baseline A plus candidate G");
  } finally { await rm(bigger.root, { recursive: true, force: true }); }
});

// S6: installer

test("installer decisions cover every target state", () => {
  const base = { sourceHash: "s", baselineHash: "b", lastInstalledHash: "l" };
  assert.equal(decide({ ...base, targetHash: null }).action, "install");
  assert.equal(decide({ ...base, targetHash: "s" }).action, "noop");
  assert.equal(decide({ ...base, targetHash: "b" }).action, "install");
  assert.equal(decide({ ...base, targetHash: "l" }).action, "install");
  assert.equal(decide({ ...base, targetHash: "hand" }).action, "refuse");
  assert.equal(decide({ ...base, lastInstalledHash: undefined, targetHash: "hand" }).action, "refuse");
});

async function installerFixture(targetText) {
  const root = await mkdtemp(path.join(os.tmpdir(), "install-"));
  const codexHome = path.join(root, "codex");
  await mkdir(codexHome);
  await writeFile(path.join(codexHome, "config.toml"), "keep = true\n");
  const source = path.join(root, "source.md");
  await writeFile(source, "new rules\n");
  const target = path.join(codexHome, "AGENTS.md");
  if (targetText !== null) await writeFile(target, targetText);
  return { root, codexHome, source, target, stateDir: path.join(root, "state") };
}

test("installer dry run writes nothing to the target", async () => {
  const fx = await installerFixture("old baseline\n");
  try {
    const result = await install({ ...fx, baselineHash: sha256(buf("old baseline\n")) });
    assert.equal(result.action, "install");
    assert.equal(result.applied, false);
    assert.equal(await readFile(fx.target, "utf8"), "old baseline\n");
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("installer replaces a baseline target, backs it up outside the Codex home, and touches nothing else there", async () => {
  const fx = await installerFixture("old baseline\n");
  try {
    const result = await install({ ...fx, baselineHash: sha256(buf("old baseline\n")), apply: true });
    assert.equal(result.applied, true);
    assert.equal(await readFile(fx.target, "utf8"), "new rules\n");
    assert.equal(await readFile(result.backup, "utf8"), "old baseline\n");
    assert.ok(result.backup.startsWith(fx.stateDir));
    assert.deepEqual((await readdir(fx.codexHome)).sort(), ["AGENTS.md", "config.toml"]);
    assert.equal(await readFile(path.join(fx.codexHome, "config.toml"), "utf8"), "keep = true\n");
    assert.deepEqual((await readdir(fx.stateDir)).sort(), ["backups", "state.json"]);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("installer refuses a hand-edited target and leaves it untouched", async () => {
  const fx = await installerFixture("my hand edit\n");
  try {
    const result = await install({ ...fx, baselineHash: sha256(buf("old baseline\n")), apply: true });
    assert.equal(result.action, "refuse");
    assert.equal(result.applied, false);
    assert.equal(await readFile(fx.target, "utf8"), "my hand edit\n");
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("installer accepts the version it installed last, then no-ops on a matching target", async () => {
  const fx = await installerFixture("old baseline\n");
  try {
    const baselineHash = sha256(buf("old baseline\n"));
    await install({ ...fx, baselineHash, apply: true });
    assert.equal((await install({ ...fx, baselineHash, apply: true })).action, "noop");
    await writeFile(fx.source, "newer rules\n");
    const again = await install({ ...fx, baselineHash, apply: true });
    assert.equal(again.action, "install");
    assert.equal(await readFile(fx.target, "utf8"), "newer rules\n");
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("installer installs into a missing target without a backup", async () => {
  const fx = await installerFixture(null);
  try {
    const result = await install({ ...fx, baselineHash: "b", apply: true });
    assert.equal(result.applied, true);
    assert.equal(result.backup, null);
    assert.equal(await readFile(fx.target, "utf8"), "new rules\n");
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("installer refuses to run while another install holds the lock, and keeps that lock", async () => {
  const fx = await installerFixture("old baseline\n");
  try {
    await mkdir(fx.stateDir, { recursive: true });
    await writeFile(path.join(fx.stateDir, "install.lock"), "");
    await assert.rejects(install({ ...fx, baselineHash: sha256(buf("old baseline\n")), apply: true }), /another install holds/);
    assert.equal(await readFile(fx.target, "utf8"), "old baseline\n");
    assert.ok((await readdir(fx.stateDir)).includes("install.lock"));
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});
