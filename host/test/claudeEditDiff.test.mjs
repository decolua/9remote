// Pins the `+`/`-` line shape AiDiffCard parses (it colours and counts by the first
// character, so a stray blank line or a lost trailing newline shows as a real change).
import assert from "node:assert/strict";
import { buildEditPatch, buildEditDiff, DIFF_TOOL_NAMES } from "../features/ai/adapters/claudeAdapter.js";

// Edit: old lines then new lines, both prefixed
assert.equal(
  buildEditPatch("Edit", { old_string: "a\nb", new_string: "a\nc" }),
  "-a\n-b\n+a\n+c"
);

// A trailing newline in the tool input must not become an empty changed line
assert.equal(
  buildEditPatch("Edit", { old_string: "x\n", new_string: "y\n" }),
  "-x\n+y"
);

// MultiEdit: every edit in the list, in order
assert.equal(
  buildEditPatch("MultiEdit", { edits: [{ old_string: "1", new_string: "2" }, { old_string: "3", new_string: "4" }] }),
  "-1\n+2\n-3\n+4"
);

// Write is a whole-file add with no old lines — the card renders `content` instead
assert.equal(buildEditPatch("Write", { file_path: "/tmp/a", content: "hello" }), "");

// A creation-shaped Edit (no old_string) is all additions, and no blank `-` line
assert.equal(buildEditPatch("Edit", { new_string: "new file" }), "+new file");

// Nothing to say -> empty, never a lone "\n"
assert.equal(buildEditPatch("Edit", {}), "");
assert.equal(buildEditPatch("MultiEdit", {}), "");

// buildEditDiff: the file path is what the client matches a tool row against, so every
// tool's own spelling of it has to resolve — NotebookEdit says notebook_path.
assert.equal(buildEditDiff("Edit", { file_path: "/a.js", old_string: "x", new_string: "y" }).file, "/a.js");
assert.equal(buildEditDiff("NotebookEdit", { notebook_path: "/b.ipynb", new_string: "z" }).file, "/b.ipynb");
assert.equal(buildEditDiff("MultiEdit", { path: "/c.js", edits: [] }).file, "/c.js");
// Write carries its body as content, never as a patch
const write = buildEditDiff("Write", { file_path: "/d.js", content: "hello" });
assert.equal(write.patch, "");
assert.equal(write.content, "hello");
// The tool name travels with the diff: the row it replaced used to show it, so the
// diff row has to carry it or the reader loses which command made the change.
assert.equal(write.name, "Write");
assert.equal(buildEditDiff("NotebookEdit", { notebook_path: "/b.ipynb" }).name, "NotebookEdit");
// No file to point at -> no diff at all, rather than a card with a blank title
assert.equal(buildEditDiff("Edit", { old_string: "x", new_string: "y" }), null);

// The set the client mirrors — a drift here shows every edited file twice
assert.deepEqual([...DIFF_TOOL_NAMES], ["Edit", "Write", "MultiEdit", "NotebookEdit"]);

console.log("buildEditPatch: all assertions passed");
