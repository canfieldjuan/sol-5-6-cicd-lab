import { closeSync, openSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Codex rollout reader (contract 5.3). Row shapes verified on real rollouts:
// assistant prose is response_item/message (role assistant, output_text parts);
// tool output is custom_tool_call_output / function_call_output, sub-agent
// reports are response_item/agent_message; shell commands
// run inside code-mode `exec` scripts as tools.exec_command({cmd: ...}); each
// turn starts with event_msg/task_started carrying turn_id.

function* lines(file) {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1 << 20);
    let rest = "";
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      const parts = (rest + buffer.toString("utf8", 0, read)).split("\n");
      rest = parts.pop();
      yield* parts;
    }
    if (rest) yield rest;
  } finally { closeSync(fd); }
}

// Python's json.loads(strict=False) accepts raw control characters inside
// strings; JSON.parse does not. Retry with them escaped, else skip the line.
function parseRow(line) {
  try { return JSON.parse(line); } catch {}
  try { return JSON.parse(line.replace(/[\u0000-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)); } catch { return null; }
}

function outputTexts(output) {
  const parts = Array.isArray(output) ? output.map((part) => (part && typeof part === "object" ? String(part.text ?? "") : String(part ?? ""))) : [typeof output === "string" ? output : JSON.stringify(output ?? "")];
  const texts = [];
  for (const part of parts) {
    texts.push(part);
    // A code-mode exec chunk is a JSON object with `output` and `exit_code`.
    // The raw text already carries every token the gates match, so only the
    // exit code needs restating in the forms a claim uses.
    if (part.trimStart().startsWith("{")) {
      try {
        const chunk = JSON.parse(part);
        if (chunk && Number.isInteger(chunk.exit_code)) texts.push(`exit_code=${chunk.exit_code} exit=${chunk.exit_code} exit code ${chunk.exit_code}`);
      } catch {}
    }
    for (const match of part.matchAll(/Process exited with code (\d+)/g)) texts.push(`exit=${match[1]} exit code ${match[1]}`);
  }
  return texts;
}

function decodeLiteral(quote, body) {
  if (quote === '"') { try { return JSON.parse(`"${body}"`); } catch { return body; } }
  if (quote === "'") return body.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  return body; // template literal: raw
}

// The cmd of every tools.exec_command call in a code-mode exec script, with
// the call's workdir when it states one.
export function execCommands(script) {
  const commands = [];
  const literal = (key) => new RegExp(`["']?(?:${key})["']?\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)'|\`((?:[^\`\\\\]|\\\\.)*)\`)`, "g");
  const decode = (match) => (match[1] !== undefined ? decodeLiteral('"', match[1]) : match[2] !== undefined ? decodeLiteral("'", match[2]) : decodeLiteral("`", match[3]));
  const calls = script.split(/tools\.exec_command\s*\(/).slice(1);
  for (const call of calls) {
    const workdir = [...call.matchAll(literal("workdir"))].map(decode)[0] ?? null;
    // One command per call: the call's own cmd is the first after its opening
    // paren; later cmd-like literals in the script belong to other code.
    const first = literal("cmd|command").exec(call);
    if (first) commands.push({ cmd: decode(first), workdir });
  }
  return commands;
}

function functionCommands(argumentsText) {
  try {
    const args = typeof argumentsText === "string" ? JSON.parse(argumentsText) : argumentsText;
    const value = args?.cmd ?? args?.command;
    const workdir = typeof args?.workdir === "string" ? args.workdir : null;
    if (typeof value === "string") return [{ cmd: value, workdir }];
    if (Array.isArray(value)) return [{ cmd: value.join(" "), workdir }];
  } catch {}
  return [];
}

// Revision 16: a CommandExecution row is one command that actually ran, with
// its argv and real cwd. The script of a -c/-lc shell argv is the command.
function executedCommand(item) {
  const argv = Array.isArray(item.command) ? item.command.map(String) : null;
  const cmd = argv ? (argv.length >= 3 && /^-l?c$/.test(argv[argv.length - 2]) ? argv[argv.length - 1] : argv.join(" ")) : String(item.command ?? "");
  let workdir = typeof item.cwd === "string" ? item.cwd : null;
  if (workdir?.startsWith("file://")) { try { workdir = fileURLToPath(workdir); } catch { workdir = null; } }
  return { cmd, workdir };
}

export function readRollout(file, { turnId = null, lastAssistantMessage = null } = {}) {
  const rows = [];
  let turnStart = 0;
  let matchedTurn = false;
  for (const line of lines(file)) {
    if (!line.trim()) continue;
    const row = parseRow(line);
    if (!row || typeof row !== "object") continue;
    const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
    if (row.type === "event_msg" && payload.type === "task_started") {
      // The Stop input's turn_id pins the turn; otherwise the last one wins.
      if (turnId && payload.turn_id === turnId) { turnStart = rows.length; matchedTurn = true; }
      else if (!matchedTurn) turnStart = rows.length;
    }
    rows.push(payload.type ? { type: row.type, payload } : null);
  }

  const prose = [];
  const evidence = [];
  const literals = [];
  const executed = [];
  rows.forEach((row, index) => {
    if (!row) return;
    const { type, payload } = row;
    const inTurn = index >= turnStart;
    if (type === "response_item" && payload.type === "custom_tool_call" && payload.name === "exec" && typeof payload.input === "string") literals.push(...execCommands(payload.input));
    else if (type === "response_item" && payload.type === "function_call") literals.push(...functionCommands(payload.arguments));
    else if (type === "event_msg" && payload.type === "item_completed" && payload.item?.type === "CommandExecution") executed.push(executedCommand(payload.item));
    if (!inTurn) return;
    if (type === "response_item" && payload.type === "message" && payload.role === "assistant") {
      const text = (payload.content ?? []).filter((part) => part && (part.type === "output_text" || part.type === "text")).map((part) => part.text ?? "").join("");
      if (text) prose.push(text);
    } else if (type === "response_item" && (payload.type === "custom_tool_call_output" || payload.type === "function_call_output")) {
      evidence.push(...outputTexts(payload.output));
    } else if (type === "response_item" && payload.type === "agent_message") {
      // A sub-agent's report to this agent (author /root/<child>, recipient
      // /root). Outbound instructions are spawn_agent/send_message calls, not
      // these rows. The Claude original counts a sub-agent result (a
      // tool_result) as evidence, so this does too.
      evidence.push(...outputTexts(payload.content));
    }
  });
  // The final message may not be flushed to the rollout when Stop fires.
  if (typeof lastAssistantMessage === "string" && lastAssistantMessage.trim() && !prose.some((text) => text.trim() === lastAssistantMessage.trim())) prose.push(lastAssistantMessage);
  // Executed rows replace the source literals (never add to them); sessions
  // from Codex versions without the rows fall back to the literals.
  return { prose, evidence, commands: executed.length ? executed : literals };
}
