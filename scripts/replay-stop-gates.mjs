#!/usr/bin/env node
// Replay the Codex Stop gates (contract 5.3) over real local rollouts: every
// native rollout's turns are cut at each task_complete and run through the
// gates as a Stop would see them. Prints the block rate and every block, for
// review against false blocks (H3). Reads ~/.codex/sessions; writes only to a
// temp directory. Rollout content never leaves the machine.
//
// Usage: node scripts/replay-stop-gates.mjs [--limit 20] [--sessions DIR] [--json]
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runStopGates } from "../hooks/codex-guards/guard.mjs";
import { fail, isMain } from "./lib.mjs";

function argValue(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function* rolloutFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* rolloutFiles(full);
    else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) yield full;
  }
}

// Native = has tool output and is not an imported transcript (imported turns
// carry no tool output and never fire Stop live).
export function isNative(text) {
  return text.includes('"custom_tool_call_output"') && !text.includes("external-import-turn");
}

export function replay(files, home = os.homedir()) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "stop-replay-"));
  const blocks = [];
  let turns = 0;
  try {
    for (const [file, text] of files) {
      const lines = text.split("\n");
      const state = { roundGuardFired: [] };
      lines.forEach((line, index) => {
        if (!line.includes('"task_complete"')) return;
        let row;
        try { row = JSON.parse(line); } catch { return; }
        if (row.payload?.type !== "task_complete") return;
        turns += 1;
        const prefix = path.join(scratch, "prefix.jsonl");
        writeFileSync(prefix, lines.slice(0, index + 1).join("\n") + "\n");
        const input = { transcript_path: prefix, stop_hook_active: false, turn_id: row.payload.turn_id ?? null, last_assistant_message: row.payload.last_agent_message ?? null };
        const { findings, errors } = runStopGates(input, state, home);
        for (const error of errors) blocks.push({ file, line: index + 1, error });
        for (const finding of findings) {
          if (finding.stamp) state.roundGuardFired.push(finding.stamp);
          blocks.push({ file, line: index + 1, code: finding.code, tokens: finding.tokens ?? null, subject: finding.stamp ?? null });
        }
      });
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  return { turns, blocks };
}

export function main(argv = process.argv.slice(2)) {
  const limit = Number(argValue(argv, "--limit", "20"));
  if (!Number.isInteger(limit) || limit < 1) return fail("--limit must be a positive integer");
  const sessions = argValue(argv, "--sessions", path.join(os.homedir(), ".codex", "sessions"));
  const files = [...rolloutFiles(sessions)].sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const native = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (isNative(text)) native.push([file, text]);
    if (native.length === limit) break;
  }
  const { turns, blocks } = replay(native);
  if (argv.includes("--json")) { process.stdout.write(JSON.stringify({ rollouts: native.length, turns, blocks }, null, 2) + "\n"); return 0; }
  const count = (code) => blocks.filter((b) => b.code === code).length;
  console.log(`rollouts ${native.length}, turns ${turns}, blocks ${blocks.length} (evidence ${count("evidence-gate")}, round ${count("round-guard")}, errors ${blocks.filter((b) => b.error).length})`);
  for (const b of blocks) console.log(`${path.basename(b.file)}:${b.line}  ${b.error ? `ERROR ${b.error}` : `${b.code}  ${b.tokens ? b.tokens.join(" | ") : b.subject}`}`);
  return 0;
}

if (isMain(import.meta.url)) process.exit(main());
