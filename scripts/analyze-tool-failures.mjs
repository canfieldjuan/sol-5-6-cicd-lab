import { createReadStream } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import readline from "node:readline";
import os from "node:os";
import path from "node:path";
import { fail, isMain } from "./lib.mjs";

// Classifies failed Codex tool calls from rollout logs and prices them
// (docs/TOOL_FAILURE_MITIGATION_CONTRACT.md, step 1, invariants A1-A5).

// A2: first match on the failing text wins.
export const CLASSES = [
  ["hook-denied", /Command blocked by PreToolUse hook|blocked by (?:a )?PreToolUse hook/],
  ["sandbox", /bwrap:|RTM_NEWADDR|fs sandbox helper|Command denied by sandbox/],
  ["bad-workdir", /Failed to create unified exec process/],
  ["patch-stale", /Failed to find expected lines|Failed to find context/],
  ["patch-malformed", /invalid hunk|Invalid patch|multiple operations target|hunk for path .* is empty|Expected update hunk|is not a valid hunk header|patch rejected/],
  ["wrong-repo-script", null], // decided by knownScripts, see classify()
  // A bare "does not exist" would swallow Postgres "role/relation ... does not exist".
  ["path-missing", /No such file or directory|ENOENT|cannot access|(?:file|directory|path)[^\n]{0,80} does not exist|Failed to read file to update|Failed to write file|cannot open/i],
  ["permission", /Permission denied|EACCES|Operation not permitted|EPERM/],
  ["vcs-auth", /Authentication failed for 'https?:|Invalid username or token|could not read Username|gh auth login|HTTP 401/],
  ["db-auth", /Peer authentication failed|password authentication failed|role "[^"]+" does not exist|no pg_hba\.conf entry|could not connect to server|connection to server .* failed/],
  ["db-sql", /relation "[^"]+" does not exist|column "[^"]+" does not exist|syntax error at or near|UndefinedTable|UndefinedColumn|violates [a-z ]*constraint|duplicate key value/],
  ["gh-usage", /Unknown JSON field|GraphQL|A query attribute must be specified|doesn't exist on type|^\{"errors":\[\{"message"|HTTP 4\d\d|^gh: /m],
  ["jq-usage", /^jq: error/m],
  ["js-wrapper", null], // decided by isJsWrapperError(), see classify()
  ["shell-quoting", /unexpected EOF while looking for matching|syntax error near unexpected token|bad substitution/],
  ["command-missing", /command not found|No module named|ModuleNotFoundError|Cannot find module|Executable doesn't exist/],
  ["resource-busy", /Address already in use|is already in use by container|EADDRINUSE/],
  ["network", /Could not resolve host|Failed to connect to|ECONNREFUSED|ETIMEDOUT|Connection reset/],
  ["timeout", /timed out|\bTerminated\b|\bKilled\b/],
  ["stdin-dead", /Unknown process id/],
  ["interactive-only", /can only be used in interactive mode|not a terminal|input device is not a TTY/],
  ["expected-check", /\bFAILED\b|\b\d+ failed\b|AssertionError|ERR_ASSERTION|^not ok \d+|error\[E\d+\]|test result: FAILED|could not compile|^Found \d+ errors?\.|error: .*\[[a-z][\w-]*\]$|Interrupted: \d+ errors? during collection|"status": "FAIL"/m]
];
export const MECHANICAL = new Set(CLASSES.map(([name]) => name).filter((name) => name !== "expected-check"));

// A1b: a tool's own error prefix at the start of a line (e.g. "sed: can't read X: No such file").
const SUSPECTED_LINE = /^[\w./-]+: (?:[^\n]*: )?(?:can't read|cannot access|No such file or directory|Permission denied|cannot open|command not found)[^\n]*/m;
const BENIGN_EXIT_ONE = /^\s*(rg|grep|git grep|diff|cmp|test|\[)\b/;
const ERROR_WORDS = /error|fatal|No such file|denied|not found|invalid/i;
const SCRIPT_RX = /(?:^|[\s;&|(])(?:bash\s+|sh\s+|\.\/)?(scripts\/[\w./-]+)/;

function isJsWrapperError(text, fromScriptError) {
  if (/exec_main\.mjs/.test(text)) return true;
  if (!fromScriptError) return false;
  if (/Traceback \(most recent call last\)|File "[^"]+", line \d+/.test(text)) return false;
  return /^\s*(Uncaught )?(SyntaxError|ReferenceError|TypeError|RangeError)\b|\bis not a function\b|\bis not defined\b/m.test(text);
}

export function classify(text, { fromScriptError = false, knownScripts = new Set() } = {}) {
  for (const [name, rx] of CLASSES) {
    if (name === "wrong-repo-script") {
      const missing = /(scripts\/[\w./-]+): No such file or directory/.exec(text);
      if (missing && knownScripts.has(missing[1])) return name;
      continue;
    }
    if (name === "js-wrapper") {
      if (isJsWrapperError(text, fromScriptError)) return name;
      continue;
    }
    if (rx.test(text)) return name;
  }
  return "other";
}

function outputText(output) {
  if (Array.isArray(output)) return output.map((item) => (item && typeof item.text === "string" ? item.text : "")).join("\n");
  return typeof output === "string" ? output : JSON.stringify(output ?? "");
}

// Returns the failing parts of one tool output record: [{ code, text, fromScriptError }].
// Only the failing command's own output is returned (contract: "failing text").
export function failingParts(text) {
  const parts = [];
  if (text.startsWith("apply_patch verification failed")) {
    return [{ code: 1, text: text.slice(0, 800), fromScriptError: false }];
  }
  const scriptError = text.indexOf("Script error:");
  if (scriptError !== -1) {
    parts.push({ code: 1, text: text.slice(scriptError + "Script error:".length, scriptError + 800), fromScriptError: true });
  } else if (text.startsWith("Script failed")) {
    parts.push({ code: 1, text: text.slice(0, 800), fromScriptError: true });
  }
  let index = 0;
  while ((index = text.indexOf('{"chunk_id"', index)) !== -1) {
    const end = matchingBrace(text, index);
    if (end === -1) break;
    try {
      const chunk = JSON.parse(text.slice(index, end + 1));
      if (chunk.exit_code !== 0 && chunk.exit_code !== null && chunk.exit_code !== undefined) {
        parts.push({ code: chunk.exit_code, text: String(chunk.output ?? "").slice(-800), fromScriptError: false });
      }
    } catch {}
    index = end + 1;
  }
  if (!parts.length) {
    const shaped = /(?:Process exited with code|Exit code:)\s*(-?\d+)[\s\S]*?Output:\n([\s\S]*)/.exec(text);
    if (shaped && Number(shaped[1]) !== 0) parts.push({ code: Number(shaped[1]), text: shaped[2].slice(-800), fromScriptError: false });
  }
  if (!parts.length && /exec_command failed for|CreateProcess \{/.test(text)) {
    parts.push({ code: 1, text: text.slice(0, 800), fromScriptError: false });
  }
  return parts;
}

function matchingBrace(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

function commandsOf(name, input) {
  if (name === "exec_command" || name === "shell" || name === "shell_command") {
    try {
      const args = JSON.parse(input);
      const cmd = Array.isArray(args.cmd) ? args.cmd.join(" ") : (args.cmd ?? args.command ?? "");
      return [Array.isArray(cmd) ? cmd.join(" ") : String(cmd)];
    } catch { return []; }
  }
  if (name === "exec") {
    return [...input.matchAll(/cmd:\s*"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n"));
  }
  return [];
}

// Code mode builds the patch as a JS string, so its newlines are escaped "\\n".
function patchTargets(input) {
  return [...String(input).matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+?)(?:\\n|\n|$)/g)].map((match) => match[1].trim());
}

// A patch is identified by its content, not the tool name: code-mode `exec`
// calls tools.apply_patch(patch) with the same patch text.
function targetOf(call, failureText) {
  if (call.name === "apply_patch" || /apply_patch/.test(failureText ?? "") || patchTargets(call.input).length) {
    const fromText = /(?:expected lines in|file to update|Failed to find context '[^']*' in) (\S+?)(?::|$)/m.exec(failureText ?? "");
    return `patch:${fromText?.[1] ?? patchTargets(call.input)[0] ?? "?"}`;
  }
  return `cmd:${call.commands[0] ?? call.name}`;
}

// Line-fed rollout parser. Rollouts can exceed V8's maximum string length
// (a 1.24 GB file was observed), so the CLI streams lines into feed().
export function createRolloutParser() {
  let model = null;
  let unparsed = 0;
  const calls = new Map();
  const records = [];
  let lastTotals = null;
  let pendingForCost = [];
  return {
    feed(line) {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch {
        try { event = JSON.parse(line.replace(/[\u0000-\u001f]/g, " ")); } catch { unparsed += 1; return; }
      }
      const payload = event.payload ?? {};
      if (event.type === "turn_context" && !model && payload.model) model = payload.model;
      if (event.type === "response_item" && (payload.type === "function_call" || payload.type === "custom_tool_call")) {
        const input = String(payload.arguments ?? "") + String(payload.input ?? "");
        calls.set(payload.call_id, { name: payload.name, input, commands: commandsOf(payload.name, input) });
      }
      if (event.type === "response_item" && (payload.type === "function_call_output" || payload.type === "custom_tool_call_output")) {
        const call = calls.get(payload.call_id);
        const record = { call: call ?? { name: "?", input: "", commands: [] }, orphan: !call, text: outputText(payload.output), cost: null, cached: null };
        records.push(record);
        pendingForCost.push(record);
      }
      if (event.type === "event_msg" && payload.type === "token_count" && payload.info) {
        const totals = JSON.stringify(payload.info.total_token_usage ?? {});
        if (totals === lastTotals) return; // repeated totals are not a new step
        lastTotals = totals;
        const last = payload.info.last_token_usage ?? {};
        const input = last.input_tokens ?? 0;
        const cached = last.cached_input_tokens ?? 0;
        for (const record of pendingForCost) { record.cost = Math.max(0, input - cached); record.cached = cached; }
        pendingForCost = [];
      }
    },
    finish() {
      return { model: model ?? "unknown", records, unparsed, orphans: records.filter((record) => record.orphan).length };
    }
  };
}

// Parses one rollout held in memory; returns { model, records, unparsed, orphans }.
export function parseRollout(text) {
  const parser = createRolloutParser();
  for (const line of text.split("\n")) parser.feed(line);
  return parser.finish();
}

export async function parseRolloutFile(file) {
  const parser = createRolloutParser();
  const lines = readline.createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) parser.feed(line);
  return parser.finish();
}

// Turns parsed records into failures with class, cost, and recovered/repeated outcome.
export function failuresOf(records, { knownScripts = new Set() } = {}) {
  const outcomes = records.map((record) => {
    const parts = failingParts(record.text);
    if (!parts.length) {
      // A1b: no recorded exit status, but a tool error line in the printed output.
      const line = record.call.name === "exec" && record.text.startsWith("Script completed") ? SUSPECTED_LINE.exec(record.text) : null;
      return line ? { class: classify(line[0], { knownScripts }), text: line[0], suspected: true } : null;
    }
    const commands = record.call.commands;
    const benign = parts.every((part) => part.code === 1 && !ERROR_WORDS.test(part.text))
      && commands.length > 0 && commands.every((command) => BENIGN_EXIT_ONE.test(command));
    if (benign) return null;
    const first = parts[0];
    return { class: classify(first.text, { fromScriptError: first.fromScriptError, knownScripts }), text: first.text };
  });
  const failures = [];
  records.forEach((record, index) => {
    const outcome = outcomes[index];
    if (!outcome) return;
    const target = targetOf(record.call, outcome.text);
    let result = "no-retry";
    for (let next = index + 1; next < Math.min(records.length, index + 6); next += 1) {
      if (targetOf(records[next].call, outcomes[next]?.text) !== target) continue;
      result = outcomes[next] ? "repeated" : "recovered";
      break;
    }
    failures.push({ class: outcome.class, cost: record.cost ?? 0, cached: record.cached ?? 0, result, target: target.slice(0, 160), suspected: Boolean(outcome.suspected) });
  });
  return failures;
}

// Scripts under <repo>/scripts for each known repo, used by wrong-repo-script.
export async function knownScriptsIn(repos) {
  const scripts = new Set();
  for (const repo of repos) {
    try {
      for (const entry of await readdir(path.join(repo, "scripts"), { withFileTypes: true })) {
        if (entry.isFile()) scripts.add(`scripts/${entry.name}`);
      }
    } catch {}
  }
  return scripts;
}

export function summarize(sessions) {
  const models = {};
  for (const session of sessions) {
    const model = (models[session.model] ??= { sessions: 0, calls: 0, unparsed: 0, orphans: 0, failures: 0, mechanical: 0, suspected: 0, uncachedCost: 0, cachedTokens: 0, classes: {} });
    model.sessions += 1;
    model.calls += session.records;
    model.unparsed += session.unparsed;
    model.orphans += session.orphans;
    for (const failure of session.failures) {
      const cls = (model.classes[failure.class] ??= { count: 0, uncachedCost: 0, recovered: 0, repeated: 0, noRetry: 0, suspected: 0 });
      if (failure.suspected) { cls.suspected += 1; model.suspected += 1; continue; } // A1b: never in counts or cost
      cls.count += 1;
      cls.uncachedCost += failure.cost;
      cls[failure.result === "no-retry" ? "noRetry" : failure.result] += 1;
      model.failures += 1;
      model.uncachedCost += failure.cost;
      model.cachedTokens += failure.cached;
      if (MECHANICAL.has(failure.class)) model.mechanical += 1;
    }
  }
  return sortKeys(models);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  return value;
}

async function rolloutFiles(root, since, until) {
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/^rollout-.*\.jsonl$/.test(entry.name)) {
        const date = /rollout-(\d{4}-\d{2}-\d{2})/.exec(entry.name)?.[1];
        if (date && date >= since && date <= until) files.push(full);
      }
    }
  };
  await walk(root);
  return files.sort();
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const since = argValue("--since");
  const until = argValue("--until");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(until ?? "")) {
    return fail("Usage: node scripts/analyze-tool-failures.mjs --since YYYY-MM-DD --until YYYY-MM-DD [--sessions DIR] [--repos a,b] [--json FILE]");
  }
  const root = argValue("--sessions") ?? path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
  const repos = (argValue("--repos") ?? "").split(",").filter(Boolean);
  const knownScripts = await knownScriptsIn(repos);
  const sessions = [];
  for (const file of await rolloutFiles(root, since, until)) {
    const parsed = await parseRolloutFile(file);
    sessions.push({ model: parsed.model, records: parsed.records.length, unparsed: parsed.unparsed, orphans: parsed.orphans, failures: failuresOf(parsed.records, { knownScripts }) });
  }
  const report = sortKeys({ window: { since, until, sessionsRoot: root, files: sessions.length }, knownScripts: [...knownScripts].sort(), models: summarize(sessions) });
  const json = JSON.stringify(report, null, 2) + "\n";
  const out = argValue("--json");
  if (out) await writeFile(out, json);
  for (const [model, stats] of Object.entries(report.models).sort((a, b) => b[1].calls - a[1].calls)) {
    if (stats.calls < 200) continue;
    console.log(`\n${model}: ${stats.sessions} sessions, ${stats.calls} calls, ${stats.failures} failures, ${stats.mechanical} mechanical (${(100 * stats.mechanical / stats.calls).toFixed(2)}/100 calls), uncached cost ${stats.uncachedCost}`);
    for (const [name, cls] of Object.entries(stats.classes).sort((a, b) => b[1].uncachedCost - a[1].uncachedCost)) {
      console.log(`  ${name.padEnd(18)} ${String(cls.count).padStart(6)}  uncached ${String(cls.uncachedCost).padStart(10)}  recovered ${cls.recovered} repeated ${cls.repeated} no-retry ${cls.noRetry}  suspected ${cls.suspected}`);
    }
  }
}

if (isMain(import.meta.url)) await main().catch((error) => fail(error.message));
