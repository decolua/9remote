// Shell command → one readable line.
//
// A tool row is a summary, not a transcript: the full command is one click away in
// the expanded body (and on hover via `title`). What belongs in the row is the shape
// of the command — the program and its meaningful operands — because `python3 - <<'PY'`
// followed by two hundred characters of heredoc tells the reader nothing.
//
// Rules, in order:
//   1. Heredocs (`<<'PY'`, `<<EOF`) end the line at the marker — the body never shows.
//   2. Redirections to /dev/null and long `--flag=value` payloads collapse to `…`.
//   3. A long quoted string collapses to a short quoted stub.
//   4. Whatever survives is truncated with `…`, never mid-word.

const MAX_LEN = 72;
const STUB_LEN = 18;

/** Collapse a long quoted literal to `'…'`, keeping the first few characters. */
function stubQuoted(text) {
  return text.replace(/(['"])((?:\\.|(?!\1).){24,})\1/g, (_, q, body) =>
    body.length <= STUB_LEN ? `${q}${body}${q}` : `${q}${body.slice(0, STUB_LEN)}…${q}`
  );
}

export function commandHint(command = "") {
  if (!command) return "";

  // 1. Heredoc: keep everything before the marker.
  let line = command.split(/\n/)[0].replace(/\s*<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?.*$/, " <<…");
  // 2. Noise that never helps at a glance.
  line = line.replace(/\s*2?>\s*\/dev\/null/g, "").replace(/\s+/g, " ").trim();
  // 3. Long quoted payloads.
  line = stubQuoted(line);

  // 4. Truncate cleanly at a word boundary when there is one.
  if (line.length > MAX_LEN) {
    const cut = line.slice(0, MAX_LEN);
    const space = cut.lastIndexOf(" ");
    line = `${(space > 24 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return line;
}
