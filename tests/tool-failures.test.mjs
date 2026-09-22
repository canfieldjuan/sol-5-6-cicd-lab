import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { rootDir } from "../scripts/lib.mjs";
import { CLASSES, classify, failingParts, failuresOf, parseRollout, parseRolloutFile, summarize } from "../scripts/analyze-tool-failures.mjs";

const fixtures = path.join(rootDir, "tests", "fixtures", "tool-failures");
const lines = (...events) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const ctx = { type: "turn_context", payload: { model: "m" } };
const tok = (total, input, cached) => ({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: total }, last_token_usage: { input_tokens: input, cached_input_tokens: cached } } } });
const execCmd = (id, cmd) => ({ type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: id, arguments: JSON.stringify({ cmd }) } });
const processOut = (id, code, output) => ({ type: "response_item", payload: { type: "function_call_output", call_id: id, output: `Chunk ID: x\nWall time: 0.0 seconds\nProcess exited with code ${code}\nOriginal token count: 1\nOutput:\n${output}` } });
const analyze = (text, options) => failuresOf(parseRollout(text).records, options);

// A2: one example per class, plus the second side of each overlap.
const CASES = [
  ["sandbox", "Failed to read file to update /a: fs sandbox helper failed: bwrap: loopback: Failed RTM_NEWADDR"],
  ["bad-workdir", 'CreateProcess { message: "Rejected(\\"Failed to create unified exec process: No such file or directory (os error 2)\\")" }'],
  ["patch-stale", "apply_patch verification failed: Failed to find expected lines in /a.md:\nold"],
  ["patch-malformed", "apply_patch verification failed: invalid patch: multiple operations target /a.py"],
  ["path-missing", "cat: /r/x.txt: No such file or directory"],
  ["permission", "open /etc/shadow: Permission denied"],
  ["db-auth", 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5433" failed: FATAL:  Peer authentication failed for user "juan"'],
  ["db-auth", 'FATAL:  role "juan-canfield" does not exist'],
  ["db-sql", 'ERROR:  relation "b2b_reviews" does not exist'],
  ["gh-usage", 'Unknown JSON field: "timelineItems"\nAvailable fields: assignees'],
  ["gh-usage", '{"errors":[{"message":"Expected one of SCHEMA, SCALAR, TYPE, actual: RCURLY at [1, 283]"}]}'],
  ["js-wrapper", "ReferenceError: wt is not defined\n    at exec_main.mjs:10:104"],
  ["shell-quoting", "bash: line 31: unexpected EOF while looking for matching ``'"],
  ["command-missing", "/usr/bin/python: No module named ruff"],
  ["network", "curl: (7) Failed to connect to 127.0.0.1 port 11434"],
  ["timeout", "✗ Wait timed out after 30000ms"],
  ["stdin-dead", "write_stdin failed: Unknown process id 31077"],
  ["interactive-only", "Error: `render ssh` can only be used in interactive mode"],
  ["expected-check", "FAILED tests/test_x.py::test_y - AssertionError"],
  ["expected-check", "error: could not compile `eom-email-watcher-desktop` (lib test) due to 1 previous error"],
  ["expected-check", "src/a.py:3:1: F401 unused import\nFound 1 error."],
  ["expected-check", 'gauntlet/runners/q.py:1035: error: Incompatible types in assignment (expression has type "int | None", variable has type "int")  [assignment]'],
  ["hook-denied", "\nCommand blocked by PreToolUse hook: [wrapper-bypass]\n\nBLOCKED: 'gh pr create' in a repo that ships scripts/open_pr.sh"],
  ["vcs-auth", "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/x/y.git/'"],
  ["jq-usage", "jq: error (at <stdin>:1): Cannot index object with number"],
  ["resource-busy", "OSError: [Errno 98] Address already in use"],
  ["resource-busy", 'docker: Error response from daemon: Conflict. The container name "/pg" is already in use by container "47ab"'],
  ["other", "something went sideways"]
];

test("every A2 class has a classification case, and each case classifies as its class", () => {
  const covered = new Set(CASES.map(([name]) => name));
  for (const [name] of CLASSES) {
    if (name !== "wrong-repo-script") assert.ok(covered.has(name), `no case for ${name}`);
  }
  for (const [expected, text] of CASES) assert.equal(classify(text), expected, text);
});

test("second sides: Postgres 'does not exist' is db, not path; sandbox wins over path", () => {
  assert.equal(classify('role "atlas" does not exist'), "db-auth");
  assert.equal(classify('column "x" does not exist'), "db-sql");
  assert.equal(classify("the directory /tmp/w does not exist"), "path-missing");
  assert.equal(classify("Failed to read file to update /a: No such file or directory"), "path-missing");
});

test("second sides for the new classes: plain errors are not checks, and a hook note in prose is not a denial", () => {
  assert.equal(classify("error: something broke"), "other");
  assert.equal(classify("the PreToolUse hook is documented here"), "other");
  assert.equal(classify("Found the file"), "other");
});

test("js-wrapper: a JS parse error after Script error: counts; a Python SyntaxError never does", () => {
  assert.equal(classify("SyntaxError: Unexpected identifier 'Worked'", { fromScriptError: true }), "js-wrapper");
  assert.equal(classify("SyntaxError: Unexpected identifier 'Worked'", { fromScriptError: false }), "other");
  const python = '  File "/r/bad.py", line 3\nSyntaxError: unexpected character after line continuation character';
  assert.notEqual(classify(python, { fromScriptError: true }), "js-wrapper");
});

test("wrong-repo-script needs the script to exist in a known repo; otherwise it is path-missing", () => {
  const text = "bash: scripts/open_pr.sh: No such file or directory";
  assert.equal(classify(text, { knownScripts: new Set(["scripts/open_pr.sh"]) }), "wrong-repo-script");
  assert.equal(classify(text), "path-missing");
});

test("failingParts reads every observed failure shape and ignores successes", () => {
  assert.equal(failingParts("apply_patch verification failed: Failed to find expected lines in /a").length, 1);
  assert.equal(failingParts("Script failed\nWall time 0.1 seconds\nOutput:\n\nScript error:\nReferenceError: x is not defined")[0].fromScriptError, true);
  assert.equal(failingParts("Chunk ID: x\nProcess exited with code 2\nOriginal token count: 1\nOutput:\nboom")[0].code, 2);
  assert.equal(failingParts("Exit code: 1\nWall time: 0 seconds\nOutput:\nbad")[0].text, "bad");
  assert.equal(failingParts('exec_command failed for `ls`: CreateProcess { message: "x" }').length, 1);
  const chunk = JSON.stringify({ chunk_id: "a", exit_code: 3, output: "nope" });
  assert.deepEqual(failingParts(`Script completed\nOutput:\n${chunk}`).map((part) => part.code), [3]);
  assert.deepEqual(failingParts("Chunk ID: x\nProcess exited with code 0\nOutput:\nok"), []);
  assert.deepEqual(failingParts("Exit code: 0\nOutput:\nSuccess. Updated the following files:"), []);
});

test("only the failing chunk is classified, never file contents printed by a successful chunk", () => {
  const ok = JSON.stringify({ chunk_id: "a", exit_code: 0, output: "class X: raise TypeError('in a file')" });
  const bad = JSON.stringify({ chunk_id: "b", exit_code: 2, output: "cat: y: No such file or directory" });
  const part = failingParts(`Script completed\nOutput:\n${ok}\n${bad}`);
  assert.equal(part.length, 1);
  assert.equal(classify(part[0].text), "path-missing");
});

test("rg/grep/test exit 1 with no error text is a no-match, not a failure; an error or other command still fails", () => {
  const noMatch = lines(ctx, execCmd("a", "rg -n needle src"), processOut("a", 1, ""), tok(1, 10, 0));
  assert.equal(analyze(noMatch).length, 0);
  const rgError = lines(ctx, execCmd("a", "rg -n needle nope/"), processOut("a", 2, "rg: nope/: No such file or directory"), tok(1, 10, 0));
  assert.equal(analyze(rgError)[0].class, "path-missing");
  const other = lines(ctx, execCmd("a", "false"), processOut("a", 1, ""), tok(1, 10, 0));
  assert.equal(analyze(other).length, 1);
});

test("cost is the next distinct step's uncached tokens; repeated totals are not a new step", () => {
  const text = lines(ctx, execCmd("a", "cat x"), processOut("a", 1, "cat: x: No such file or directory"),
    tok(100, 5000, 4000), tok(100, 9999, 0));
  const [failure] = analyze(text);
  assert.equal(failure.cost, 1000);
  assert.equal(failure.cached, 4000);
  const repeated = lines(ctx, tok(100, 1, 0), execCmd("a", "cat x"), processOut("a", 1, "No such file or directory"), tok(100, 9999, 0), tok(200, 3000, 2500));
  assert.equal(analyze(repeated)[0].cost, 500);
});

test("recovered, repeated, and no-retry follow the same target", () => {
  const patch = (id, file) => ({ type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: id, input: `*** Update File: ${file}\n` } });
  const patchOut = (id, text) => ({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: text } });
  const stale = (file) => `apply_patch verification failed: Failed to find expected lines in ${file}:\nx`;
  const recovered = lines(ctx, patch("a", "/f.md"), patchOut("a", stale("/f.md")), patch("b", "/f.md"), patchOut("b", "Exit code: 0\nOutput:\nSuccess."));
  assert.equal(analyze(recovered)[0].result, "recovered");
  const again = lines(ctx, patch("a", "/f.md"), patchOut("a", stale("/f.md")), patch("b", "/f.md"), patchOut("b", stale("/f.md")));
  assert.equal(analyze(again)[0].result, "repeated");
  const elsewhere = lines(ctx, patch("a", "/f.md"), patchOut("a", stale("/f.md")), patch("b", "/g.md"), patchOut("b", "Exit code: 0\nOutput:\nok"));
  assert.equal(analyze(elsewhere)[0].result, "no-retry");
});

test("code-mode apply_patch (patch built in JS, escaped newlines) is matched to its retry", () => {
  const input = 'const patch = "*** Begin Patch\\n*** Update File: /r/plan.md\\n@@\\n-a\\n+b\\n*** End Patch";\nconst result = await tools.apply_patch(patch);\ntext(result);\n';
  const execPatch = (id) => ({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: id, input } });
  const execOut = (id, text) => ({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: [{ type: "input_text", text }] } });
  const text = lines(ctx,
    execPatch("a"), execOut("a", "Script failed\nOutput:\n\nScript error:\napply_patch verification failed: Failed to find expected lines in /r/plan.md:\n-a"),
    execPatch("b"), execOut("b", "Script completed\nOutput:\nSuccess. Updated the following files:\nM /r/plan.md"));
  const [failure] = analyze(text);
  assert.equal(failure.class, "patch-stale");
  assert.equal(failure.target, "patch:/r/plan.md");
  assert.equal(failure.result, "recovered");
});

test("A1b: a code-mode record with no exit status but a tool error line is suspected, and kept out of counts and cost", () => {
  const exec = (id) => ({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: id, input: 'const r = await tools.exec_command({ cmd: "sed -n 1,9p scripts/open_pr.sh" }); text(r.output);' } });
  const out = (id, body) => ({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: [{ type: "input_text", text: `Script completed\nWall time 0.2 seconds\nOutput:\n\n${body}` }] } });
  const text = lines(ctx, exec("a"), out("a", "sed: can't read scripts/open_pr.sh: No such file or directory"), tok(1, 900, 100));
  const failures = analyze(text, { knownScripts: new Set(["scripts/open_pr.sh"]) });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].suspected, true);
  const summary = summarize([{ model: "m", records: 1, unparsed: 0, orphans: 0, failures }]).m;
  assert.equal(summary.failures, 0);
  assert.equal(summary.uncachedCost, 0);
  assert.equal(summary.suspected, 1);
  assert.equal(summary.classes["wrong-repo-script"].suspected, 1);
  // A document that mentions the phrase mid-line is not a suspected failure.
  const doc = lines(ctx, exec("b"), out("b", "The runbook says the error reads: sed: can't read x.md: No such file or directory"), tok(2, 900, 100));
  assert.equal(analyze(doc).length, 0);
});

test("orphan outputs and unparsed lines are counted, not dropped", () => {
  const text = lines(ctx, processOut("nocall", 1, "No such file or directory")) + "{not json\n";
  const parsed = parseRollout(text);
  assert.equal(parsed.orphans, 1);
  assert.equal(parsed.unparsed, 1);
});

test("a line with raw control characters is still parsed", () => {
  const raw = JSON.stringify({ type: "turn_context", payload: { model: "ctrl" } }).replace('"ctrl"', '"ct\u0001rl"');
  assert.equal(parseRollout(raw + "\n").unparsed, 0);
});

test("audited misclassifications: each fixture classifies correctly (the scratch analyzer failed all four)", async () => {
  const expectations = {
    "sandbox-as-path": ["sandbox"],
    "python-syntax-not-js": ["other"],
    "direct-apply-patch": ["patch-stale"],
    "exec-command-process-exited": ["path-missing"]
  };
  for (const [name, classes] of Object.entries(expectations)) {
    const failures = analyze(await readFile(path.join(fixtures, `${name}.jsonl`), "utf8"));
    assert.deepEqual(failures.map((failure) => failure.class), classes, name);
  }
  const [patched] = analyze(await readFile(path.join(fixtures, "direct-apply-patch.jsonl"), "utf8"));
  assert.equal(patched.result, "recovered");
  assert.equal(patched.cost, 200);
});

test("summaries are deterministic and keyed in sorted order", async () => {
  const sessions = [];
  for (const name of ["sandbox-as-path", "direct-apply-patch", "exec-command-process-exited"]) {
    const parsed = parseRollout(await readFile(path.join(fixtures, `${name}.jsonl`), "utf8"));
    sessions.push({ model: parsed.model, records: parsed.records.length, unparsed: parsed.unparsed, orphans: parsed.orphans, failures: failuresOf(parsed.records) });
  }
  const once = JSON.stringify(summarize(sessions));
  assert.equal(JSON.stringify(summarize(sessions)), once);
  const model = summarize(sessions).m;
  assert.deepEqual(Object.keys(model.classes), [...Object.keys(model.classes)].sort());
  assert.equal(model.mechanical, 3);
});

test("streaming a file parses exactly like the in-memory path", async () => {
  for (const name of ["sandbox-as-path", "python-syntax-not-js", "direct-apply-patch", "exec-command-process-exited"]) {
    const file = path.join(fixtures, `${name}.jsonl`);
    const streamed = await parseRolloutFile(file);
    const inMemory = parseRollout(await readFile(file, "utf8"));
    assert.deepEqual(failuresOf(streamed.records), failuresOf(inMemory.records), name);
    assert.equal(streamed.model, inMemory.model);
  }
});

test("the CLI refuses to run without an explicit window", () => {
  const result = spawnSync(process.execPath, [path.join(rootDir, "scripts", "analyze-tool-failures.mjs"), "--sessions", fixtures], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--since YYYY-MM-DD --until YYYY-MM-DD/);
});
