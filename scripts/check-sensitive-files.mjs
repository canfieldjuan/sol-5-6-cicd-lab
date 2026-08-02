import path from "node:path";
import { readJson, rootDir, walkFiles, relativeFromRoot, fail, isMain } from "./lib.mjs";

export async function findSensitiveFiles() {
  const contract = await readJson(path.join(rootDir, "ci-contract.json"));
  const patterns = contract.sensitiveFiles.denyNamePatterns.map((pattern) => new RegExp(pattern, "i"));
  const allowed = new Set(contract.sensitiveFiles.allowPaths);
  const findings = [];
  for (const deployableRoot of contract.sensitiveFiles.deployableRoots) {
    for (const file of await walkFiles(path.join(rootDir, deployableRoot))) {
      const relative = relativeFromRoot(file);
      if (!allowed.has(relative) && patterns.some((pattern) => pattern.test(relative))) findings.push(relative);
    }
  }
  return findings;
}

async function main() {
  const findings = await findSensitiveFiles();
  if (findings.length) return fail(`Sensitive-looking files found in deployable paths:\n- ${findings.join("\n- ")}`);
  console.log("No sensitive-looking deployable files found.");
}

if (isMain(import.meta.url)) await main();
