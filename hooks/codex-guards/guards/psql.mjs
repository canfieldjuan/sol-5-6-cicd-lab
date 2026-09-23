import { segments } from "../lib/shell.mjs";

// Guard 3 (contract 5.2): bare `psql` connects over the Unix socket as the OS
// user and fails peer authentication. When the guard config names the target
// database, add only the connection flags that are missing (H1a rewrite: the
// correct command is certain). Anything already stated is left alone.

const VALUE_OPTIONS = new Set(["-c", "-d", "-f", "-h", "-p", "-U", "-v", "-o", "-F", "-R", "-P", "-L", "-T", "--command", "--dbname", "--file", "--host", "--port", "--username", "--variable", "--output", "--set"]);

const SHORT_WITH_VALUE = new Set(["c", "d", "f", "h", "p", "U", "v", "o", "F", "R", "P", "L", "T"]);
const FLAG_FOR = { h: "host", p: "port", U: "user", d: "db" };

function analyze(words) {
  const has = { host: false, port: false, user: false, db: false };
  const positional = [];
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i];
    if (/^(postgres(ql)?:\/\/|.*\bhost=)/.test(word)) { has.host = has.port = has.user = has.db = true; continue; } // URI / conninfo
    if (word.startsWith("--")) {
      const [name] = word.slice(2).split("=");
      const key = { host: "host", port: "port", username: "user", dbname: "db" }[name];
      if (key) has[key] = true;
      if (!word.includes("=") && VALUE_OPTIONS.has(`--${name}`)) i += 1;
      continue;
    }
    if (word.startsWith("-") && word.length > 1) {
      // Bundled short options, e.g. -Atc: letters until one that takes a value;
      // its value is the rest of the word, or else the next word.
      for (let j = 1; j < word.length; j += 1) {
        const letter = word[j];
        if (FLAG_FOR[letter]) has[FLAG_FOR[letter]] = true;
        if (SHORT_WITH_VALUE.has(letter)) { if (j === word.length - 1) i += 1; break; }
      }
      continue;
    }
    positional.push(word);
  }
  if (positional.length >= 1) has.db = true;   // psql [dbname [username]]
  if (positional.length >= 2) has.user = true;
  return has;
}

export function checkPsql({ command, config }) {
  const db = config?.db;
  if (!db) return null;
  const text = String(command);
  const parsed = segments(text);
  if (!parsed) return null;
  const targets = parsed.filter((words) => words[0] === "psql");
  if (!targets.length) return null;
  // Each psql occurrence in the original text, in order, at a segment start.
  const starts = [...text.matchAll(/(^|&&|\|\||[;|\n])(\s*)psql(?=\s|$)/g)].map((match) => match.index + match[1].length + match[2].length + "psql".length);
  if (starts.length !== targets.length) return null; // cannot map words to text safely
  let rewritten = text;
  let changed = false;
  for (let index = targets.length - 1; index >= 0; index -= 1) {
    const has = analyze(targets[index]);
    if (has.host) continue; // an explicit host means the caller chose the connection
    const flags = [`-h ${db.host}`, has.port ? null : `-p ${db.port}`, has.user ? null : `-U ${db.user}`, has.db ? null : `-d ${db.database}`].filter(Boolean);
    rewritten = `${rewritten.slice(0, starts[index])} ${flags.join(" ")}${rewritten.slice(starts[index])}`;
    changed = true;
  }
  return changed ? { action: "rewrite", code: "psql", command: rewritten } : null;
}
