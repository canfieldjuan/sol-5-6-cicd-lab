import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decide, main } from "../hooks/codex-guards/guard.mjs";
import { checkPsql } from "../hooks/codex-guards/guards/psql.mjs";

const config = { db: { host: "localhost", port: 5433, user: "atlas", database: "atlas" } };
const rewrite = (command) => checkPsql({ command, config })?.command ?? null;

test("bare psql gains the full connection; the rest of the command is untouched", () => {
  assert.equal(rewrite("psql -c 'select 1'"), "psql -h localhost -p 5433 -U atlas -d atlas -c 'select 1'");
  assert.equal(rewrite("cd /r && psql -Atc \"select 1\" | head -1"), "cd /r && psql -h localhost -p 5433 -U atlas -d atlas -Atc \"select 1\" | head -1");
});

test("only missing flags are added: stated port, user, db, or positional db/user are kept", () => {
  assert.equal(rewrite("psql -p 5433 -c 'x'"), "psql -h localhost -U atlas -d atlas -p 5433 -c 'x'");
  assert.equal(rewrite("psql -U postgres -d other -c 'x'"), "psql -h localhost -p 5433 -U postgres -d other -c 'x'");
  assert.equal(rewrite("psql other -c 'x'"), "psql -h localhost -p 5433 -U atlas other -c 'x'");
  assert.equal(rewrite("psql other someone -c 'x'"), "psql -h localhost -p 5433 other someone -c 'x'");
  assert.equal(rewrite("psql --dbname=other -c 'x'"), "psql -h localhost -p 5433 -U atlas --dbname=other -c 'x'");
  assert.equal(rewrite("psql -Uatlas -Atc 'x'"), "psql -h localhost -p 5433 -d atlas -Uatlas -Atc 'x'", "bundled -U with attached value");
  assert.equal(rewrite("psql -At -c 'x'"), "psql -h localhost -p 5433 -U atlas -d atlas -At -c 'x'", "flags without values do not consume the next word");
});

test("left alone: an explicit host, a URI or conninfo, PGHOST prefix, sudo -u postgres, unreadable shell, no psql, no config", () => {
  for (const command of [
    "psql -h db.example -c 'x'", "psql --host=db -c 'x'", "psql -hlocalhost -c 'x'", "psql -Ah db -c 'x'", "psql postgresql://u@h/d -c 'x'", "psql 'host=localhost dbname=x' -c 'y'",
    "PGHOST=localhost psql -c 'x'", "sudo -u postgres psql -c 'x'", "psql -c \"select $X\"", "echo psql", "ls"
  ]) assert.equal(rewrite(command), null, command);
  assert.equal(checkPsql({ command: "psql -c 'x'", config: {} }), null);
});

test("two psql calls in one command are both rewritten, at the right places", () => {
  assert.equal(rewrite("psql -c 'a' && psql -h db -c 'b'; psql -c 'c'"), "psql -h localhost -p 5433 -U atlas -d atlas -c 'a' && psql -h db -c 'b'; psql -h localhost -p 5433 -U atlas -d atlas -c 'c'");
});

test("dispatcher returns allow + updatedInput, and main logs the rewrite", async () => {
  const { output } = decide({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "psql -c 'x'" } }, { pending: [] }, { config });
  assert.equal(output.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(output.hookSpecificOutput.updatedInput.command, "psql -h localhost -p 5433 -U atlas -d atlas -c 'x'");
  const state = await mkdtemp(path.join(os.tmpdir(), "guard-state-"));
  try {
    await writeFile(path.join(state, "config.json"), JSON.stringify(config));
    let out = "";
    main(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: { command: "psql -c 'x'" } }), { ...process.env, SOL_LAB_GUARD_STATE: state }, (text) => { out += text; });
    assert.equal(JSON.parse(out).hookSpecificOutput.updatedInput.command, "psql -h localhost -p 5433 -U atlas -d atlas -c 'x'");
    assert.match(await readFile(path.join(state, "denials.jsonl"), "utf8"), /"code":"psql","kind":"rewrite"/);
  } finally { await rm(state, { recursive: true, force: true }); }
});

test("safety: psql inside quoted text makes the rewrite back off rather than insert flags in the wrong place", () => {
  assert.equal(rewrite(`echo "note; psql here" && psql -c 'x'`), null, "text scan sees two psql starts, words see one: back off");
  assert.equal(rewrite(`echo "note; psql" && psql -c 'x'`), `echo "note; psql" && psql -h localhost -p 5433 -U atlas -d atlas -c 'x'`, "a quoted psql not followed by a space is not a command start");
});

test("only a psql that starts a segment is rewritten; sudo -u postgres psql beside it is left alone", () => {
  assert.equal(rewrite("sudo -u postgres psql -c 'a'; psql -c 'b'"), "sudo -u postgres psql -c 'a'; psql -h localhost -p 5433 -U atlas -d atlas -c 'b'");
});
