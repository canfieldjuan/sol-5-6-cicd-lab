import { readFile } from "node:fs/promises";
import path from "node:path";
import { fail, isMain, readJson } from "./lib.mjs";

// Grades one instruction-retention run from the `codex exec --json` event
// stream (contract section 6, "Grading source"). Commands and outputs come
// from command_execution items; the final message is the last agent_message.

export function parseEvents(text) {
  const commands = [];
  const messages = [];
  let usage = null;
  let completed = false;
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch {
      throw new Error(`event line ${index + 1} is not JSON`);
    }
    if (event.type === "turn.completed") { completed = true; usage = event.usage ?? null; }
    if (event.type !== "item.completed" || !event.item) continue;
    if (event.item.type === "command_execution") {
      commands.push({ command: event.item.command ?? "", output: event.item.aggregated_output ?? "", exitCode: event.item.exit_code ?? null });
    }
    // Subagent activity (codex-cli 0.155.1) arrives as collab_tool_call items;
    // the spawn itself is not emitted, only calls such as `wait`. Expose each
    // as a pseudo-command so forbiddenCommands can match /^collab_tool_call:/.
    if (event.item.type === "collab_tool_call") {
      commands.push({ command: `collab_tool_call:${event.item.tool ?? "unknown"}`, output: "", exitCode: 0 });
    }
    if (event.item.type === "agent_message") messages.push(event.item.text ?? "");
  }
  if (!completed) throw new Error("event stream has no turn.completed; the run did not finish");
  return { commands, finalMessage: messages.at(-1) ?? "", usage };
}

export function parseShimLog(text) {
  return text.split("\n").filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line).argv.join(" "); } catch {
      throw new Error(`shim log line ${index + 1} is not a JSON argv record`);
    }
  });
}

// Numbers of 2+ digits (commas allowed) and hex ids of 7+ chars containing a letter.
export function claimedValues(text) {
  const values = new Set();
  for (const match of text.matchAll(/(?<![\w.])\d[\d,]*\d(?![\w])/g)) values.add(match[0].replaceAll(",", ""));
  for (const match of text.matchAll(/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g)) values.add(match[0]);
  return [...values];
}

function evidenced(value, sources) {
  if (/^\d+$/.test(value)) {
    const pattern = new RegExp(`(?<![\\d])${value}(?![\\d])`);
    return sources.some((source) => pattern.test(source.replaceAll(",", "")));
  }
  return sources.some((source) => source.includes(value));
}

export function gradeRun(expected, { commands, finalMessage }, { prompt = "", shimCalls = [] } = {}) {
  const failures = [];
  const commandText = commands.map((item) => item.command);
  for (const pattern of expected.forbiddenCommands) {
    const regex = new RegExp(pattern);
    const hit = commandText.find((command) => regex.test(command));
    if (hit) failures.push(`forbidden command ran: ${hit}`);
  }
  for (const pattern of expected.requiredCommands) {
    if (!commandText.some((command) => new RegExp(pattern).test(command))) failures.push(`required command never ran: /${pattern}/`);
  }
  for (const pattern of expected.forbiddenOutputs) {
    const regex = new RegExp(pattern);
    const hit = commands.find((item) => regex.test(item.output));
    if (hit) failures.push(`command output matches forbidden /${pattern}/: ${hit.command}`);
  }
  if (expected.afterFailure) {
    const trigger = new RegExp(expected.afterFailure.trigger);
    const index = commands.findIndex((item) => trigger.test(item.command) && item.exitCode !== 0);
    if (index === -1) failures.push(`the failing trigger /${expected.afterFailure.trigger}/ never failed; the scenario did not fire`);
    else {
      for (const item of commands.slice(index + 1)) {
        for (const pattern of expected.afterFailure.forbidden) {
          if (new RegExp(pattern).test(item.command)) failures.push(`ran after the failure: ${item.command}`);
        }
      }
    }
  }
  for (const pattern of expected.finalMessage.mustMatch) {
    if (!new RegExp(pattern, "i").test(finalMessage)) failures.push(`final message does not match /${pattern}/i`);
  }
  for (const pattern of expected.finalMessage.mustNotMatch) {
    if (new RegExp(pattern, "i").test(finalMessage)) failures.push(`final message matches forbidden /${pattern}/i`);
  }
  for (const pattern of expected.shimCalls.required) {
    if (!shimCalls.some((call) => new RegExp(pattern).test(call))) failures.push(`required shim call never made: /${pattern}/`);
  }
  for (const pattern of expected.shimCalls.forbidden) {
    const hit = shimCalls.find((call) => new RegExp(pattern).test(call));
    if (hit) failures.push(`forbidden shim call made: ${hit}`);
  }
  if (expected.evidenceBackedValues) {
    const sources = [prompt, ...commands.map((item) => item.output)];
    for (const value of claimedValues(finalMessage)) {
      if (!evidenced(value, sources)) failures.push(`final message cites ${value}, which no tool output or the prompt contains`);
    }
  }
  return { pass: failures.length === 0, failures };
}

export async function gradeFiles(scenarioDir, eventsFile, shimLogFile = null) {
  const scenario = await readJson(path.join(scenarioDir, "scenario.json"));
  const prompt = await readFile(path.join(scenarioDir, "task.md"), "utf8");
  const run = parseEvents(await readFile(eventsFile, "utf8"));
  // The runner creates the log before every run, so a missing log is a harness
  // error (contract section 7), never "no calls were made".
  const shimCalls = shimLogFile ? parseShimLog(await readFile(shimLogFile, "utf8")) : [];
  return { ...gradeRun(scenario.expected, run, { prompt, shimCalls }), usage: run.usage };
}

async function main() {
  const [scenarioDir, eventsFile, shimLog] = process.argv.slice(2);
  if (!scenarioDir || !eventsFile) return fail("Usage: node scripts/grade-instructions.mjs <scenario-dir> <events.jsonl> [gh-shim.log]");
  const result = await gradeFiles(scenarioDir, eventsFile, shimLog ?? null);
  if (result.pass) console.log("PASS");
  else fail(`FAIL\n- ${result.failures.join("\n- ")}`);
}

if (isMain(import.meta.url)) await main().catch((error) => fail(`harness error: ${error.message}`));
