// Parse unified diff text into flat rows for the mobile (no-table) renderer.
// Extracted verbatim from GitPanel.

const HEADER_PREFIXES = ["diff --git", "index ", "new file", "deleted file", "--- ", "+++ "];

export function parseUnifiedDiff(text) {
  const rows = [];
  let oldLn = 0, newLn = 0;
  for (const line of text.split("\n")) {
    if (HEADER_PREFIXES.some((p) => line.startsWith(p))) {
      // Only the `diff --git` line carries the filename worth showing.
      if (line.startsWith("diff --git")) {
        rows.push({ type: "file", text: line.replace("diff --git a/", "").split(" b/")[0] });
      }
      continue;
    }
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldLn = parseInt(m[1], 10); newLn = parseInt(m[2], 10); }
      rows.push({ type: "hunk", text: line });
      continue;
    }
    if (line.startsWith("+")) rows.push({ type: "add", text: line.slice(1), newLn: newLn++ });
    else if (line.startsWith("-")) rows.push({ type: "del", text: line.slice(1), oldLn: oldLn++ });
    else rows.push({ type: "ctx", text: line.slice(1), oldLn: oldLn++, newLn: newLn++ });
  }
  return rows;
}
