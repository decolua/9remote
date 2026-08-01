// OS-like copy conflict resolution. Per-file Skip/Replace, with global
// Skip-all / Replace-all switches. Pure logic (no React) so it's testable
// from node and reusable across the UI.
export const CONFLICT_CHOICE = {
  SKIP: "skip",
  REPLACE: "replace",
  SKIP_ALL: "skipAll",
  REPLACE_ALL: "replaceAll"
};

export class ConflictResolver {
  constructor() {
    this.skipAll = false;
    this.replaceAll = false;
  }

  // Decide what to do for a candidate whose target may already exist.
  // Returns "write" (no conflict), "skip" / "replace" (via global flag), or
  // "ask" (UI must prompt the user for this one).
  resolve(fileExists) {
    if (!fileExists) return "write";
    if (this.replaceAll) return "replace";
    if (this.skipAll) return "skip";
    return "ask";
  }

  // Record the user's choice for the current conflict. Only the *All variants
  // persist; per-file Skip/Replace apply just to the file being asked about.
  record(choice) {
    if (choice === CONFLICT_CHOICE.SKIP_ALL) this.skipAll = true;
    else if (choice === CONFLICT_CHOICE.REPLACE_ALL) this.replaceAll = true;
  }
}
