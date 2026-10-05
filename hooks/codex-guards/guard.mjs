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
import { answeredScope, checkScope, loadScope, scopeBaseline, scopeDrift } from "./guards/scope.mjs";
import { readRollout } from "./lib/rollout.mjs";
import { CODE as SEAM, seamAfter, seamBefore } from "./guards/seam.mjs";
import { checkEvidence } from "./stop/evidence-gate.mjs";

export const GUARDS = [
  { code: "read-path", check: checkReadPath, after: checkReadFailure, satisfied: satisfiesReadPath, answered: answeredReadPath },
  { code: "wrong-repo-script", check: checkWrongRepoScript, after: checkWrongRepoFailure, satisfied: satisfiesWrongRepoScript, answered: answeredWrongRepoScript },
  { code: "psql", check: checkPsql },
  { code: "gh-fields", check: checkGhFields, satisfied: satisfiesGhFields },
  { code: "rediscovery", check: checkRediscoveryBefore },
  { code: "scope", check: checkScope, answered: answeredScope }
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
// Codex ports of the Stop gates (contract 5.3). Each reads the rollout at
// transcript_path; a failing gate is skipped and reported (H4). Revision 18
// retired the round guard's Stop checkpoint: its push counting drives the seam
// redirect at the push instead (guards/seam.mjs), so nothing for fix loops runs
// at Stop.
export const STOP_GATES = [
  ["evidence-gate", (rollout) => checkEvidence(rollout)]
];

export function runStopGates(input, state, home, gates = STOP_GATES) {
  const findings = [];
  const errors = [];
  if (!input.transcript_path || input.stop_hook_active) return { findings, errors };
  let rollout;
  try {
    rollout = readRollout(input.transcript_path, { turnId: input.turn_id ?? null, lastAssistantMessage: input.last_assistant_message ?? null });
  } catch (error) {
    errors.push(`stop gates: cannot read ${input.transcript_path}: ${error.message}`);
    return { findings, errors };
  }
  for (const [name, gate] of gates) {
    try { const finding = gate(rollout, state, home); if (finding) findings.push(finding); } catch (error) { errors.push(`${name}: ${error.stack ?? error}`); }
  }
  return { findings, errors };
}

// Runs one seam step (contract 5.4). It applies to shell commands only, never to
// apply_patch text, and fails open (SR5): an error leaves the call alone.
function seamEvent(input, command, state, step) {
  if (!command || input.tool_name === "apply_patch") return null;
  try { return step({ command, seam: state.seam }); }
  catch (error) { return { error: `seam: ${error.stack ?? error}` }; }
}

// Adds seam redirects to a guard result: their text joins any context output,
// each is logged by kind, and the seam state is kept. They never ride on a deny
// or a rewrite.
function withSeam(result, seam, hookEventName) {
  if (!seam) return result;
  if (seam.error) return { ...result, errors: [...(result.errors ?? []), seam.error] };
  const merged = { ...result, state: { ...result.state, seam: seam.seam } };
  const hookOutput = result.output?.hookSpecificOutput;
  if (!seam.fired.length || hookOutput?.permissionDecision) return merged;
  const text = seam.fired.map((item) => item.reason);
  const context = [hookOutput?.additionalContext, ...text].filter(Boolean).join("\n\n");
  const earlier = result.redirected || result.rewritten ? [{ code: result.redirected ?? result.rewritten, kind: result.redirected ? result.redirectKind : "rewrite" }] : [];
  return {
    ...merged,
    output: { hookSpecificOutput: { hookEventName, additionalContext: context } },
    log: [...earlier, ...seam.fired.map((item) => ({ code: SEAM, kind: item.kind }))]
  };
}

export function decide(input, state, { home = os.homedir(), guards = GUARDS, config = {}, stopGates = runStopGates } = {}) {
  const event = input.hook_event_name;
  const pending = [...(state.pending ?? [])];
  const result = decideInner(input, state, pending, { home, guards, config, stopGates });
  // Keep state beyond `pending` (e.g. the scope baseline) across every event.
  return { ...result, state: { ...state, ...result.state } };
}

function decideInner(input, state, pending, { home, guards, config, stopGates }) {
  const event = input.hook_event_name;
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";

  if (event === "PreToolUse") {
    // A later call can satisfy an earlier redirect.
    const remaining = pending.filter((item) => {
      const guard = guards.find((candidate) => candidate.code === item.code);
      return !(guard?.satisfied && guard.satisfied(item, command));
    });
    let result = null;
    for (const guard of guards) {
      const finding = guard.check({ toolName: input.tool_name, command, home, cwd: input.cwd, config });
      if (!finding) continue;
      if (finding.action === "context") {
        // Context-only PreToolUse output (Q10): the call runs, the hint reaches the model.
        result = { output: { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: finding.reason } }, state: { pending: remaining }, redirected: guard.code, redirectKind: finding.kind ?? "context" };
      } else if (finding.action === "rewrite") {
        result = { output: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...input.tool_input, command: finding.command } } }, state: { pending: remaining }, rewritten: guard.code };
      } else {
        // A denied call never runs: no push to count, no seam redirect.
        return {
          output: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: finding.reason } },
          state: { pending: [...remaining, { ...finding.pending, reason: finding.reason }] },
          denied: guard.code
        };
      }
      break;
    }
    // Seam redirect (contract 5.4). A rewritten call still runs, so its pushes
    // count, but no redirect rides on the rewrite output (an unprobed shape).
    const seam = seamEvent(input, command, state, (args) => seamBefore({ ...args, cwd: input.cwd, emit: !result?.rewritten }));
    return withSeam(result ?? { output: null, state: { pending: remaining } }, seam, "PreToolUse");
  }

  if (event === "PostToolUse") {
    // After-failure branches (contract revision 7): context + pending redirect.
    let result = null;
    for (const guard of guards) {
      const finding = guard.after?.({ toolName: input.tool_name, command, response: input.tool_response, cwd: input.cwd, home, config });
      if (!finding) continue;
      // Context-only findings (guard 5) record no pending redirect.
      const duplicate = !finding.pending || pending.some((item) => item.code === finding.code && JSON.stringify(item.dir ?? item.script) === JSON.stringify(finding.pending.dir ?? finding.pending.script));
      result = {
        output: { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: finding.reason } },
        state: { pending: duplicate ? pending : [...pending, { ...finding.pending, reason: finding.reason }] },
        redirected: guard.code,
        redirectKind: finding.kind ?? "after-failure"
      };
      break;
    }
    const seam = seamEvent(input, command, state, (args) => seamAfter({ ...args, response: input.tool_response, cwd: input.cwd }));
    return withSeam(result ?? { output: null, state: { pending } }, seam, "PostToolUse");
  }

  if (event === "Stop") {
    // H1b backstop: block once while redirects are pending; never twice.
    // Scope drift (revision 12): files dirtied since session start outside the allow globs.
    const drift = state.scopeBaseline ? scopeDrift({ cwd: input.cwd, baseline: state.scopeBaseline }) : null;
    if (drift) pending.push(drift);
    // Reported drift joins the baseline so the same files never block a later turn.
    const acknowledged = drift ? { scopeBaseline: Object.fromEntries(Object.entries(state.scopeBaseline).map(([root, files]) => [root, [...new Set([...files, ...(drift.byRoot[root] ?? [])])]])) } : {};
    // Revision 9: a redirect the final message already acts on is resolved.
    const open = pending.filter((item) => {
      const guard = guards.find((candidate) => candidate.code === item.code);
      return !(guard?.answered && guard.answered(item, input.last_assistant_message));
    });
    const { findings, errors } = stopGates(input, state, home);
    if ((open.length || findings.length) && !input.stop_hook_active) {
      const sections = [];
      if (open.length) sections.push(`Before finishing, act on the guard redirect(s) below; they were blocked, not resolved.\n\n${open.map((item) => item.reason).join("\n\n")}`);
      sections.push(...findings.map((finding) => finding.reason));
      const log = [
        ...(drift && open.some((item) => item === drift) ? [{ code: "scope", kind: "stop-drift" }] : []),
        ...findings.map((finding) => ({ code: finding.code, kind: finding.kind }))
      ];
      return { output: { decision: "block", reason: sections.join("\n\n---\n\n") }, state: { pending: [], ...acknowledged }, log, errors, ...(drift && open.some((item) => item === drift) ? { redirected: "scope", redirectKind: "stop-drift" } : {}) };
    }
    return { output: null, state: { pending: [], ...acknowledged }, errors };
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
  const previous = readJson(file, { pending: [] });
  // Scope baseline (revision 12): snapshot at the first guard event where scope.json is active.
  if (!previous.scopeBaseline) {
    const scope = loadScope(input.cwd);
    if (scope?.error && !previous.scopeErrorLogged) {
      appendFileSync(path.join(dir, "errors.log"), `${new Date().toISOString()} scope: ${scope.error}\n`);
      previous.scopeErrorLogged = true;
    }
    previous.scopeBaseline = scopeBaseline(input.cwd);
  }
  const { output, state, denied, redirected, redirectKind, rewritten, log, errors } = decide(input, previous, { home: env.HOME || os.homedir(), config });
  writeJsonAtomic(file, state);
  const entries = log ?? (denied || redirected || rewritten ? [{ code: denied ?? redirected ?? rewritten, kind: denied ? "deny" : redirected ? redirectKind : "rewrite" }] : []);
  for (const entry of entries) appendFileSync(path.join(dir, "denials.jsonl"), JSON.stringify({ at: new Date().toISOString(), session: input.session_id ?? null, ...entry }) + "\n");
  for (const error of errors ?? []) appendFileSync(path.join(dir, "errors.log"), `${new Date().toISOString()} ${error}\n`);
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
