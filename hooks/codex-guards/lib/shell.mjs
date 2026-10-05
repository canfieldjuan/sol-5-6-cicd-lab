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

// Removes heredocs so the shell around them can be read (contract 5.4,
// revision 18): each `<<WORD` / `<<-WORD` operator (word bare or quoted) and its
// body, from the next line through the line that is exactly WORD (leading tabs
// allowed for `<<-`). An unterminated body runs to the end. Quoted text is
// masked first, so a `<<` inside quotes is not an operator; `<<<` is a
// here-string, not a heredoc. `segments` itself still refuses heredocs.
const HEREDOC = /(?<!<)<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2(?!<)/g;

function maskQuotes(line) {
  let out = "";
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (quote === '"' && ch === "\\" && i + 1 < line.length) { out += "__"; i += 1; continue; }
      if (ch === quote) quote = null;
      out += ch === quote || quote === null ? ch : "_";
    } else {
      if (ch === "'" || ch === '"') quote = ch;
      out += ch;
    }
  }
  return out;
}

export function withoutHeredocs(command) {
  const out = [];
  const bodies = [];
  for (const line of String(command).split("\n")) {
    if (bodies.length) {
      const { word, tabs } = bodies[0];
      if ((tabs ? line.replace(/^\t+/, "") : line) === word) bodies.shift();
      continue;
    }
    const masked = maskQuotes(line);
    let kept = "";
    let from = 0;
    for (const match of masked.matchAll(HEREDOC)) {
      // The word may be quoted, so read it from the original line.
      const original = line.slice(match.index, match.index + match[0].length);
      const word = /([A-Za-z_][A-Za-z0-9_]*)['"]?$/.exec(original)[1];
      bodies.push({ word, tabs: match[1] === "-" });
      kept += line.slice(from, match.index);
      from = match.index + match[0].length;
    }
    out.push(kept + line.slice(from));
  }
  return out.join("\n");
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
