import path from "node:path";
import { isMain, readJson, rootDir, walkFiles } from "./lib.mjs";

async function main() {
  if (process.argv[2] !== "list") throw new Error("Usage: node scripts/scenarios.mjs list");
  const files = (await walkFiles(path.join(rootDir, "scenarios"))).filter((file) => path.basename(file) === "scenario.json");
  for (const file of files) {
    const scenario = await readJson(file);
    console.log(`${scenario.lane.padEnd(14)} ${scenario.id.padEnd(28)} ${scenario.description}`);
  }
}

if (isMain(import.meta.url)) await main();
