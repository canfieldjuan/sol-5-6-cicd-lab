#!/usr/bin/env node
// Codex guard dispatcher (docs/TOOL_FAILURE_MITIGATION_CONTRACT.md 5.2).
// Invoked by Codex for PreToolUse, PostToolUse, and Stop. Any error fails open:
// the call is allowed and the error is logged (H4). Nothing here ends a turn.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { answeredReadPath, checkReadFailure, checkReadPath, satisfiesReadPath } from "./guards/read-path.mjs";
import { answeredWrongRepoScript, checkWrongRepoFailure, checkWrongRepoScript, satisfiesWrongRepoScript } from "./guards/wrong-repo-script.mjs";
import { checkPsql } from "./guards/psql.mjs";
import { checkGhFields, satisfiesGhFields } from "./guards/gh-fields.mjs";
import { checkRediscoveryBefore } from "./guards/rediscovery.mjs";

export const GUARDS = [
  { code: "read-path", check: checkReadPath, after: checkReadFailure, satisfied: satisfiesReadPath, answered: answeredReadPath },
  { code: "wrong-repo-script", check: checkWrongRepoScript, after: checkWrongRepoFailure, satisfied: satisfiesWrongRepoScript, answered: answeredWrongRepoScript },
  { code: "psql", check: checkPsql },
  { code: "gh-fields", check: checkGhFields, satisfied: satisfiesGhFields },
  { code: "rediscovery", check: checkRediscoveryBefore }
];

export function stateDir(env = process.env) {
  return env.SOL_LAB_GUARD_STATE || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "sol-lab", "guards");
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
  renameSync(temporary, file);
}

const sessionFile = (dir, sessionId) => path.join(dir, `session-${String(sessionId || "unknown").replace(/[^\w.-]/g, "_")}.json`);

// Pure decision function: returns { output, state } for one hook event.
export function decide(input, state, { home = os.homedir(), guards = GUARDS, config = {} } = {}) {
  const event = input.hook_event_name;
  const pending = [...(state.pending ?? [])];
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";

  if (event === "PreToolUse") {
    // A later call can satisfy an earlier redirect.
    const remaining = pending.filter((item) => {
      const guard = guards.find((candidate) => candidate.code === item.code);
      return !(guard?.satisfied && guard.satisfied(item, command));
    });
    for (const guard of guards) {
      const finding = guard.check({ toolName: input.tool_name, command, home, cwd: input.cwd, config });
      if (!finding) continue;
      if (finding.action === "context") {
        // Context-only PreToolUse output (Q10): the call runs, the hint reaches the model.
        return { output: { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: finding.reason } }, state: { pending: remaining }, redirected: guard.code, redirectKind: finding.kind ?? "context" };
      }
      if (finding.action === "rewrite") {
        return { output: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...input.tool_input, command: finding.command } } }, state: { pending: remaining }, rewritten: guard.code };
      }
      return {
        output: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: finding.reason } },
        state: { pending: [...remaining, { ...finding.pending, reason: finding.reason }] },
        denied: guard.code
      };
    }
    return { output: null, state: { pending: remaining } };
  }

  if (event === "PostToolUse") {
    // After-failure branches (contract revision 7): context + pending redirect.
    for (const guard of guards) {
      const finding = guard.after?.({ toolName: input.tool_name, command, response: input.tool_response, cwd: input.cwd, home, config });
      if (!finding) continue;
      // Context-only findings (guard 5) record no pending redirect.
      const duplicate = !finding.pending || pending.some((item) => item.code === finding.code && JSON.stringify(item.dir ?? item.script) === JSON.stringify(finding.pending.dir ?? finding.pending.script));
      return {
        output: { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: finding.reason } },
        state: { pending: duplicate ? pending : [...pending, { ...finding.pending, reason: finding.reason }] },
        redirected: guard.code,
        redirectKind: finding.kind ?? "after-failure"
      };
    }
    return { output: null, state: { pending } };
  }

  if (event === "Stop") {
    // H1b backstop: block once while redirects are pending; never twice.
    // Revision 9: a redirect the final message already acts on is resolved.
    const open = pending.filter((item) => {
      const guard = guards.find((candidate) => candidate.code === item.code);
      return !(guard?.answered && guard.answered(item, input.last_assistant_message));
    });
    if (open.length && !input.stop_hook_active) {
      const reasons = open.map((item) => item.reason).join("\n\n");
      return { output: { decision: "block", reason: `Before finishing, act on the guard redirect(s) below; they were blocked, not resolved.\n\n${reasons}` }, state: { pending: [] } };
    }
    return { output: null, state: { pending: [] } };
  }

  return { output: null, state: { pending } };
}

export function run(rawInput, env = process.env) {
  const dir = stateDir(env);
  mkdirSync(dir, { recursive: true });
  const input = JSON.parse(rawInput || "{}");
  writeJsonAtomic(path.join(dir, "heartbeat.json"), { at: new Date().toISOString(), event: input.hook_event_name ?? null, session: input.session_id ?? null });
  const file = sessionFile(dir, input.session_id);
  // Per-machine guard config (contract revision 8); absent config = those guards do nothing.
  const config = readJson(path.join(dir, "config.json"), {});
  const { output, state, denied, redirected, redirectKind, rewritten } = decide(input, readJson(file, { pending: [] }), { home: env.HOME || os.homedir(), config });
  writeJsonAtomic(file, state);
  if (denied || redirected || rewritten) {
    const kind = denied ? "deny" : redirected ? redirectKind : "rewrite";
    appendFileSync(path.join(dir, "denials.jsonl"), JSON.stringify({ at: new Date().toISOString(), session: input.session_id ?? null, code: denied ?? redirected ?? rewritten, kind }) + "\n");
  }
  return output;
}

export function main(stdinText, env = process.env, write = (text) => process.stdout.write(text)) {
  try {
    const output = run(stdinText, env);
    if (output) write(JSON.stringify(output));
  } catch (error) {
    try {
      const dir = stateDir(env);
      mkdirSync(dir, { recursive: true });
      appendFileSync(path.join(dir, "errors.log"), `${new Date().toISOString()} ${error.stack ?? error}\n`);
    } catch {}
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  let text = "";
  try { text = readFileSync(0, "utf8"); } catch {}
  main(text);
  process.exit(0);
}
