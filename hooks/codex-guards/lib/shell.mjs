// Conservative shell reader for the Codex guards (contract section 5.2).
// It understands simple commands joined by ; && || | and newlines. Anything it
// cannot read with certainty (command substitution, heredocs, variables,
// unbalanced quotes) makes it return null, and the caller must then allow the
// call (H3: no false blocks).

const OPERATORS = ["&&", "||", ";", "|", "\n"];

// Returns an array of segments, each an array of words with quotes removed, or
// null when the command is not safely readable.
export function segments(command) {
  if (/\$\(|`|<<|\$\{|\$[A-Za-z_]/.test(command)) return null;
  const result = [];
  let words = [];
  let word = "";
  let inWord = false;
  let quote = null;
  const endWord = () => { if (inWord) words.push(word); word = ""; inWord = false; };
  const endSegment = () => { endWord(); if (words.length) result.push(words); words = []; };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; inWord = true; continue; }
    if (ch === "\\" && i + 1 < command.length) {
      if (command[i + 1] === "\n") { i += 1; continue; } // line continuation
      word += command[++i]; inWord = true; continue;
    }
    const op = OPERATORS.find((candidate) => command.startsWith(candidate, i));
    if (op) { endSegment(); i += op.length - 1; continue; }
    if (ch === "&") { endSegment(); continue; } // background job: new segment
    if (ch === " " || ch === "\t") { endWord(); continue; }
    word += ch; inWord = true;
  }
  if (quote) return null;
  endSegment();
  return result;
}

// Resolves a path argument against a known base. Returns null when the base
// is unknown for a relative path, or the argument is not a literal path.
export function resolvePath(arg, base, home) {
  if (!arg || /[*?[\]{}]/.test(arg)) return null;
  if (arg === "~" || arg.startsWith("~/")) return home + arg.slice(1);
  if (arg.startsWith("/")) return normalize(arg);
  if (!base) return null;
  return normalize(`${base}/${arg}`);
}

function normalize(path) {
  const parts = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}
