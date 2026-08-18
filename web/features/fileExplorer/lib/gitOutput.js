// Friendly one-line git result summaries, shared by GitActionsModal and ScmPanel.
// Raw git output stays visible only on failure — it carries the reject reason.

const firstMatch = (out, pred) => (out || "").split("\n").map(s => s.trim()).find(pred) || "";

export const commitSummary = (t, out) => {
  const line = firstMatch(out, s => /files? changed/.test(s));
  return t("git.commitSuccess") + (line ? ` · ${line}` : "");
};

export const pushSummary = (t, out) => {
  if (/up.to.date/i.test(out || "")) return t("git.upToDate");
  const line = firstMatch(out, s => s.includes("->"));
  return t("git.pushSuccess") + (line ? ` · ${line}` : "");
};

export const pullSummary = (t, out) => {
  if (/already up to date|up.to.date/i.test(out || "")) return t("git.upToDate");
  const line = firstMatch(out, s => /files? changed|fast-forward/i.test(s));
  return t("git.pullSuccess") + (line ? ` · ${line}` : "");
};
