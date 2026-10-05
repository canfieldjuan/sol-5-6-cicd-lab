import { closeSync, openSync, rmSync, statSync } from "node:fs";

// Serializes one session's read, decide, and write across concurrent hook
// processes (contract 5.4, revision 20): Claude Code runs the hooks of
// parallel tool calls at once. Bounded, so a killed hook cannot stall the
// session (H4): a waiter gives up after `wait` ms and the caller skips the
// event (SR5), and a lock older than `stale` ms (the hook timeout) was left
// by a killed hook and is removed.
export const LOCK_WAIT_MS = 2000;
export const LOCK_STALE_MS = 10000;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function withSessionLock(file, fn, { wait = LOCK_WAIT_MS, stale = LOCK_STALE_MS } = {}) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + wait;
  for (;;) {
    try { closeSync(openSync(lock, "wx")); break; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    let age;
    try { age = Date.now() - statSync(lock).mtimeMs; }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (age > stale) { rmSync(lock, { force: true }); continue; }
    if (Date.now() >= deadline) throw new Error(`session lock ${lock} held past ${wait} ms; event skipped`);
    sleep(5 + Math.floor(Math.random() * 20));
  }
  try { return fn(); } finally { rmSync(lock, { force: true }); }
}
