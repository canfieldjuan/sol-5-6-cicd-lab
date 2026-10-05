#!/usr/bin/env node
// Claude Code entry point for the seam redirect (contract 5.4, revision 20).
// Registered for PreToolUse and PostToolUse with matcher Bash. It calls the
// dispatcher's decide() with no other guards, as the replay does, so R1-R3,
// keys, epochs, and texts are the seam module's: there is no second
// implementation. Any error fails open (SR5): no output, exit 0, errors.log.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decide, readJson, sessionFile, writeJsonAtomic } from "./guard.mjs";

const EVENTS = new Set(["PreToolUse", "PostToolUse"]);
const noStopGates = () => ({ findings: [], errors: [] });

export function claudeStateDir(env = process.env) {
  return env.SOL_LAB_CLAUDE_SEAM_STATE || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "sol-lab", "claude-seam");
}

// Claude's Bash tool_response is an object: { stdout, stderr, ... } in session
// transcripts, { type, text } in the hooks reference example. R1 reads one
// text, as the Codex aggregated output, so the parts are joined.
export function responseText(response) {
  if (typeof response === "string") return response;
  if (Array.isArray(response)) return response.map(responseText).filter(Boolean).join("\n");
  if (!response || typeof response !== "object") return "";
  return [response.stdout, response.stderr, response.text].filter((part) => typeof part === "string" && part).join("\n");
}

// Pure: { output, state, log } for one Claude hook event.
export function decideClaude(input, state) {
  if (input.tool_name !== "Bash" || !EVENTS.has(input.hook_event_name)) return { output: null, state, log: [] };
  const mapped = input.hook_event_name === "PostToolUse" ? { ...input, tool_response: responseText(input.tool_response) } : input;
  const result = decide(mapped, state, { guards: [], stopGates: noStopGates });
  return { output: result.output ?? null, state: result.state, log: result.log ?? [], errors: result.errors ?? [] };
}

export function run(rawInput, env = process.env) {
  const dir = claudeStateDir(env);
  mkdirSync(dir, { recursive: true });
  const input = JSON.parse(rawInput || "{}");
  writeJsonAtomic(path.join(dir, "heartbeat.json"), { at: new Date().toISOString(), event: input.hook_event_name ?? null, session: input.session_id ?? null });
  const file = sessionFile(dir, input.session_id);
  const { output, state, log, errors } = decideClaude(input, readJson(file, { pending: [] }));
  writeJsonAtomic(file, state);
  for (const entry of log) appendFileSync(path.join(dir, "redirects.jsonl"), JSON.stringify({ at: new Date().toISOString(), session: input.session_id ?? null, ...entry }) + "\n");
  for (const error of errors ?? []) appendFileSync(path.join(dir, "errors.log"), `${new Date().toISOString()} ${error}\n`);
  return output;
}

export function main(stdinText, env = process.env, write = (text) => process.stdout.write(text)) {
  try {
    const output = run(stdinText, env);
    if (output) write(JSON.stringify(output));
  } catch (error) {
    try {
      const dir = claudeStateDir(env);
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
