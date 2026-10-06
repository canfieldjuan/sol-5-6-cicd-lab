#!/usr/bin/env node
// Replay the seam redirect (contract 5.4) over real local rollouts. Each
// executed command (a CommandExecution row, revision 16) is fed in order to the
// dispatcher as a PreToolUse event, then as a PostToolUse event carrying the
// row's output, from a fresh state. Only the seam path runs (no other guard
// touches the filesystem here). Prints every redirect with its row timestamp,
// and, for each subject that reached 5 pushes (where the retired Stop
// checkpoint fired), the first redirect in that span from the same directory
// scope and how many pushes earlier it came. Reads local rollouts only; nothing leaves the machine.
//
// One difference from a live session: hooks see the session cwd, not the
// command's workdir (probe Q7), while the replay passes the row's real cwd.
// That only changes the keys of HEAD and bare pushes.
//
// A Claude Code transcript (`--claude`, revision 22) is replayed through the
// Claude adapter instead: each Bash tool call with the tool result that
// answers it. Its rows carry the session cwd, which is what the hook sees.
//
// Usage: node scripts/replay-seam-redirect.mjs <rollout.jsonl> [--json]
//        node scripts/replay-seam-redirect.mjs --recent 20 [--sessions DIR] [--json]
//        node scripts/replay-seam-redirect.mjs --claude <transcript.jsonl> [--json]
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideClaude } from "../hooks/codex-guards/claude-seam.mjs";
import { decide } from "../hooks/codex-guards/guard.mjs";
import { CODE, PUSH_ESCALATION } from "../hooks/codex-guards/guards/seam.mjs";
import { executedCommand } from "../hooks/codex-guards/lib/rollout.mjs";
import { withoutHeredocs } from "../hooks/codex-guards/lib/shell.mjs";
import { directoryOf, pushesIn } from "../hooks/codex-guards/stop/round-guard.mjs";
import { fail, isMain } from "./lib.mjs";
import { isNative, rolloutFiles } from "./replay-stop-gates.mjs";

const TIER = 5;

function argValue(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

// The CommandExecution rows of a rollout, in order.
function* executions(text) {
  for (const line of text.split("\n")) {
    if (!line.includes('"CommandExecution"')) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const item = row?.payload?.item;
    if (row.type !== "event_msg" || row.payload.type !== "item_completed" || item?.type !== "CommandExecution") continue;
    yield { at: row.timestamp ?? null, item };
  }
}

// Each executed command, as {at, cmd, workdir, response}.
function* codexCommands(text) {
  for (const { at, item } of executions(text)) {
    const { cmd, workdir } = executedCommand(item);
    yield { at, cmd, workdir, response: item.aggregated_output ?? "" };
  }
}

// Each Bash tool call in a Claude Code transcript, in order, with the
// `toolUseResult` (stdout and stderr) of the row that answers it.
export function* claudeCommands(text) {
  const rows = [];
  for (const line of text.split("\n")) { try { rows.push(JSON.parse(line)); } catch {} }
  const results = new Map();
  for (const row of rows) {
    if (row?.type !== "user" || !Array.isArray(row.message?.content)) continue;
    for (const block of row.message.content) if (block?.type === "tool_result") results.set(block.tool_use_id, row.toolUseResult ?? block.content ?? "");
  }
  const seen = new Set();
  for (const row of rows) {
    if (row?.type !== "assistant" || !Array.isArray(row.message?.content)) continue;
    for (const block of row.message.content) {
      if (block?.type !== "tool_use" || block.name !== "Bash" || seen.has(block.id)) continue;
      seen.add(block.id);
      yield { at: row.timestamp ?? null, cmd: String(block.input?.command ?? ""), workdir: row.cwd ?? null, response: results.get(block.id) ?? "" };
    }
  }
}

export function replaySeam(text, { claude = false } = {}) {
  let state = { pending: [] };
  const timeline = [];
  const counts = {};
  let commands = 0;
  const record = (result, at, scopes) => {
    const kinds = (result.log ?? []).filter((entry) => entry.code === CODE).map((entry) => entry.kind);
    if (!kinds.length) return;
    const textOut = result.output.hookSpecificOutput.additionalContext;
    // Headers and escalation lines: R1's review-round line, R2's escalation (revision 21).
    const headlines = textOut.split("\n").filter((line) => line.startsWith("[seam-redirect]") || line.startsWith("Review round") || line === PUSH_ESCALATION);
    // Epochs are per directory scope (revision 19); the replay reports the
    // session-wide push count once the redirecting call is counted.
    const afterPushes = Object.values(state.seam?.epochs ?? {}).reduce((sum, n) => sum + n, 0);
    timeline.push({ type: "redirect", at, kinds, afterPushes, scopes, headlines });
  };
  const step = claude ? (input, current) => decideClaude({ session_id: "replay", ...input }, current) : (input, current) => decide(input, current, { guards: [] });
  for (const { at, cmd, workdir, response } of claude ? claudeCommands(text) : codexCommands(text)) {
    commands += 1;
    const base = { tool_name: "Bash", cwd: workdir, tool_input: { command: cmd } };
    const pushes = pushesIn({ cmd, workdir });
    // The directory scopes this command acts in (revision 19): its own, and
    // each push's. A checkpoint only counts redirects from its subject's scope.
    const scopes = [...new Set([directoryOf(withoutHeredocs(String(cmd)), workdir), ...pushes.map((push) => push.dir)].map((dir) => dir ?? "?"))];
    const before = step({ hook_event_name: "PreToolUse", ...base }, state);
    state = before.state;
    record(before, at, scopes);
    for (const push of pushes) {
      counts[push.key] = (counts[push.key] ?? 0) + 1;
      timeline.push({ type: "push", at, subject: push.key, dir: push.dir ?? "?", round: counts[push.key] });
    }
    const after = step({ hook_event_name: "PostToolUse", ...base, tool_response: response }, state);
    state = after.state;
    record(after, at, scopes);
  }
  return { commands, timeline, checkpoints: checkpoints(timeline) };
}

// For each subject's 5th push (the retired Stop checkpoint), the first
// redirect between that subject's first and 5th push from the 5th push's
// directory scope. A redirect from another repository does not count.
function checkpoints(timeline) {
  const result = [];
  const firstPush = {};
  const seen = {};
  timeline.forEach((event, index) => {
    if (event.type !== "push") return;
    firstPush[event.subject] ??= index;
    if (event.round !== TIER) return;
    seen[event.subject] = 0;
    let first = null;
    for (const earlier of timeline.slice(firstPush[event.subject], index)) {
      if (earlier.type === "push" && earlier.subject === event.subject) seen[event.subject] = earlier.round;
      if (earlier.type === "redirect" && earlier.scopes.includes(event.dir) && !first) first = { at: earlier.at, kinds: earlier.kinds, pushesEarlier: TIER - seen[event.subject] };
    }
    result.push({ subject: event.subject, checkpointAt: event.at, firstRedirect: first });
  });
  return result;
}

function summarize(file, replayed) {
  const redirects = replayed.timeline.filter((event) => event.type === "redirect");
  const pushes = replayed.timeline.filter((event) => event.type === "push");
  const byKind = (kind) => redirects.filter((event) => event.kinds.includes(kind)).length;
  const gaps = new Set(redirects.map((event) => event.afterPushes)).size;
  return { file, commands: replayed.commands, pushes: pushes.length, redirects: redirects.length, review: byKind("review"), push: byKind("push"), followup: byKind("followup"), pushGapsWithRedirect: gaps, checkpoints: replayed.checkpoints, redirectsDetail: redirects };
}

export function main(argv = process.argv.slice(2)) {
  const recent = argValue(argv, "--recent", null);
  let files;
  if (recent !== null) {
    const limit = Number(recent);
    if (!Number.isInteger(limit) || limit < 1) return fail("--recent must be a positive integer");
    const sessions = argValue(argv, "--sessions", path.join(os.homedir(), ".codex", "sessions"));
    const sorted = [...rolloutFiles(sessions)].sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    files = [];
    for (const file of sorted) {
      if (isNative(readFileSync(file, "utf8"))) files.push(file);
      if (files.length === limit) break;
    }
  } else {
    files = argv.filter((arg) => !arg.startsWith("--"));
    if (!files.length) return fail("usage: replay-seam-redirect.mjs <rollout.jsonl> | --recent N [--sessions DIR] | --claude <transcript.jsonl> [--json]");
  }
  const claude = argv.includes("--claude");
  const reports = files.map((file) => summarize(file, replaySeam(readFileSync(file, "utf8"), { claude })));
  if (argv.includes("--json")) { process.stdout.write(JSON.stringify(reports, null, 2) + "\n"); return 0; }
  for (const report of reports) {
    console.log(`${path.basename(report.file)}: commands ${report.commands}, pushes ${report.pushes}, redirects ${report.redirects} (review ${report.review}, push ${report.push}, followup ${report.followup}) in ${report.pushGapsWithRedirect} push gaps`);
    for (const event of report.redirectsDetail) console.log(`  ${event.at}  ${event.kinds.join("+").padEnd(8)} push count ${event.afterPushes}  ${event.headlines.map((line) => line.slice(0, 110)).join(" / ")}`);
    for (const point of report.checkpoints) {
      const first = point.firstRedirect ? `first redirect ${point.firstRedirect.at} (${point.firstRedirect.kinds.join("+")}), ${point.firstRedirect.pushesEarlier} pushes earlier` : "no redirect before it";
      console.log(`  checkpoint (push ${TIER}) on ${point.subject} at ${point.checkpointAt}: ${first}`);
    }
  }
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main();
