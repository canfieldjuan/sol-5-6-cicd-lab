#!/usr/bin/env node
// Probe hook for docs/TOOL_FAILURE_MITIGATION_CONTRACT.md section 5. It logs every
// event it receives and answers from marker strings in the call:
//   PROBE_DENY    -> PreToolUse deny with a redirect reason
//   PROBE_REWRITE -> PreToolUse allow + updatedInput (rewrite to echo PROBE_REWRITTEN)
//   PROBE_CTX     -> PostToolUse additionalContext asking for the word MARMALADE
//   Stop (first time) -> block, asking the model to run echo PROBE_STOP_CONTINUED
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const [logPath, markerPath] = process.argv.slice(2);
const input = JSON.parse(readFileSync(0, "utf8") || "{}");
appendFileSync(logPath, JSON.stringify(input) + "\n");
const event = input.hook_event_name;
const call = JSON.stringify(input.tool_input ?? {});
const respond = (value) => process.stdout.write(JSON.stringify(value));

if (event === "PreToolUse" && call.includes("PROBE_DENY")) {
  respond({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: "PROBE: this command is blocked. Run `echo PROBE_REDIRECT_OK` instead, then continue." } });
} else if (event === "PreToolUse" && call.includes("PROBE_REWRITE")) {
  const toolInput = { ...input.tool_input, command: "echo PROBE_REWRITTEN" };
  respond({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: toolInput } });
} else if (event === "PreToolUse" && call.includes("PROBE_PRECTX")) {
  // Q10: context-only PreToolUse output (no permission decision).
  respond({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "PROBE: include the word QUINCE in your final answer." } });
} else if (event === "PostToolUse" && JSON.stringify(input.tool_response ?? "").includes("PROBE_CTX")) {
  respond({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "PROBE: include the word MARMALADE in your final answer." } });
} else if (event === "Stop" && !input.stop_hook_active && !existsSync(markerPath)) {
  writeFileSync(markerPath, "blocked once\n");
  respond({ decision: "block", reason: "PROBE: before finishing, run `echo PROBE_STOP_CONTINUED`, then finish with your summary." });
}
