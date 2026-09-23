// Evidence gate, Codex port (contract 5.3). The rules are a verbatim port of
// ~/.claude/hooks/evidence-gate.sh, except the revision-15 divergences named
// below; tests/codex-stop-parity.test.mjs holds both to the same verdicts on
// everything else. The transcript reader differs.

const TEST_CTX = /\b(test|tests|testing|suite|suites|pytest|spec|specs|unit|integration|table|rows?|gate|ci|check|checks|case|cases|assertion|assertions|coverage|regression)\b/i;
const GIT_CTX = /\b(commit|commits|committed|sha|hash|squash|squashed|merge|merged|head|rev|revision|branch|tag|push|pushed|cherry-pick|ref|refs|object|blob|tree|checkout|rebase|diff|pr)\b/i;

const PATTERNS = [
  [/::test_[A-Za-z0-9_]+/g, "test node", null],
  // Revision 15: "#90 passed" is an identifier (a PR number), not a count.
  [/(?<!#)\b\d+\s+(?:passed|failed)\b/g, "test count", TEST_CTX],
  [/\bexit(?:=|\s+code\s+)\d+\b/g, "exit code", null],
  [/\b(?=[0-9a-f]{7,40}\b)[0-9a-f]*[a-f][0-9a-f]*\b/g, "git object id", GIT_CTX]
];

const HEDGE = /\b(i (?:claimed|said|reported|stated)|claimed (?:earlier|above)|earlier|previously|above|unverified|not verified|no longer|was wrong|turned out|stale|i have not|haven't (?:run|verified)|cannot verify)\b/i;
const BOUNDARIES = [". ", "! ", "? ", "\n"];

function sentenceAround(text, start, end) {
  const left = Math.max(...BOUNDARIES.map((sep) => text.lastIndexOf(sep, start - 1)));
  const rights = BOUNDARIES.map((sep) => text.indexOf(sep, end)).filter((index) => index !== -1);
  return text.slice(left + 1, rights.length ? Math.min(...rights) : text.length);
}

// Returns the unbacked result-shaped tokens, as "label: token" lines (max 12).
export function unbackedClaims(proseParts, evidenceParts) {
  // Fenced blocks are quoted evidence, not fresh assertions.
  const prose = proseParts.join("\n").replace(/```[\s\S]*?```/g, " ");
  const evidence = evidenceParts.join("\n").toLowerCase();
  const seen = new Set();
  const bad = [];
  for (const [pattern, label, context] of PATTERNS) {
    for (const match of prose.matchAll(pattern)) {
      const token = match[0];
      const key = token.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (evidence.includes(key)) continue;
      const sentence = sentenceAround(prose, match.index, match.index + token.length);
      if (HEDGE.test(sentence)) continue;
      if (context && !context.test(sentence)) continue;
      if (label === "git object id" && !/^[0-9a-f]{7,40}$/.test(token)) continue;
      bad.push(`${label}: ${token}`);
    }
  }
  return bad.slice(0, 12);
}

export function evidenceReason(unbacked) {
  return "[evidence-gate] Your reply asserts results that do not appear in any tool output from this turn:\n\n" + unbacked.join("\n") +
    "\n\nGlobal rule 3: never cite a number, hash, count, or test node in prose that did not appear verbatim in a tool result THIS turn. On 2026-08-08 this exact class shipped twice in ATLAS #2331: a Review Contract citing ::test_ nodes that had already been deleted.\n\nDo one of:\n  1. RUN the thing and quote the real output, or\n  2. rewrite the sentence to say it is unverified, or\n  3. attribute it (\"I claimed X earlier\") instead of asserting it as fact.\n\nIf the token is genuinely from an earlier turn, say so explicitly rather than restating it as a fresh result.";
}

export function checkEvidence({ prose, evidence }) {
  if (!prose.length) return null;
  const unbacked = unbackedClaims(prose, evidence);
  return unbacked.length ? { code: "evidence-gate", kind: "stop-evidence", reason: evidenceReason(unbacked), tokens: unbacked } : null;
}
