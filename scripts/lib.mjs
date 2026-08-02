import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function walkFiles(directory) {
  const found = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return found;
    throw error;
  }

  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walkFiles(target));
    if (entry.isFile()) found.push(target);
  }
  return found.sort();
}

export function displayCommand(command) {
  return command.map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(" ");
}

export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && metaUrl === pathToFileURL(path.resolve(process.argv[1])).href;
}

export function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

export function relativeFromRoot(file) {
  return path.relative(rootDir, file).split(path.sep).join("/");
}

export function assertObject(value, label, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  return true;
}

export function assertExactKeys(value, required, optional, label, errors) {
  if (!assertObject(value, label, errors)) return;
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!(key in value)) errors.push(`${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label}.${key} is not allowed`);
  }
}
