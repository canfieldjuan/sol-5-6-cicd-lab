import { spawnSync } from "node:child_process";
import { segments } from "../lib/shell.mjs";

// H2: a reason must name a next action that exists. codex-pr-status is named
// only when it is actually on PATH.
const helperOnPath = () => spawnSync("sh", ["-c", "command -v codex-pr-status"], { encoding: "utf8", timeout: 2000 }).status === 0;

// Guard 4 (contract 5.2): a `gh <group> <command> --json` naming fields that
// gh does not accept fails for certain. Valid fields come from gh itself,
// captured at install into the guard config (`ghFields`), so they match the
// installed gh version. Deny + Stop backstop; the reason lists the valid
// fields and names codex-pr-status for PR state, checks, and threads.

function jsonFields(words) {
  for (let i = 0; i < words.length; i += 1) {
    if (words[i] === "--json") return words[i + 1] ?? "";
    if (words[i].startsWith("--json=")) return words[i].slice("--json=".length);
  }
  return null;
}

function invalidFields(words, config) {
  if (words[0] !== "gh" || words.length < 3) return null;
  const key = `${words[1]} ${words[2]}`;
  const valid = config?.ghFields?.[key];
  if (!valid) return null;
  const requested = jsonFields(words);
  if (requested === null || requested === "") return null;
  const bad = requested.split(",").map((field) => field.trim()).filter((field) => field && !valid.includes(field));
  return bad.length ? { key, bad, valid } : null;
}

export function checkGhFields({ command, config, helperInstalled = helperOnPath }) {
  const text = String(command);
  const parsed = segments(text);
  if (!parsed) return null;
  for (const words of parsed) {
    const found = invalidFields(words, config);
    if (!found) continue;
    // Lead with the concrete fix: the same command with the invalid fields removed.
    const kept = jsonFields(words).split(",").map((field) => field.trim()).filter((field) => field && found.valid.includes(field));
    const requested = jsonFields(words);
    const escaped = requested.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const retry = kept.length ? text.replace(new RegExp(`(--json[ =]["']?)${escaped}`), `$1${kept.join(",")}`) : null;
    const helper = found.key.startsWith("pr ") && helperInstalled() ? " For PR state, checks, reviews, and unresolved threads, `codex-pr-status --repo OWNER/NAME --pr N` returns them in one call." : "";
    const reason = `[gh-fields] \`gh ${found.key} --json\` has no field(s): ${found.bad.join(", ")}.${retry ? ` Retry with: \`${retry}\`.` : ""} Valid fields: ${found.valid.join(", ")}.${helper}`;
    return { action: "deny", code: "gh-fields", reason, pending: { code: "gh-fields", key: found.key, valid: found.valid } };
  }
  return null;
}

// Satisfied by a later call to the same gh command whose fields are all valid,
// or by switching to codex-pr-status.
export function satisfiesGhFields(pending, command) {
  const text = String(command);
  if (/\bcodex-pr-status\b/.test(text)) return true;
  const parsed = segments(text);
  if (!parsed) return false;
  return parsed.some((words) => words[0] === "gh" && `${words[1]} ${words[2]}` === pending.key && !invalidFields(words, { ghFields: { [pending.key]: pending.valid } }));
}
