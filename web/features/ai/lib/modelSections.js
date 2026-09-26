// Model catalog sectioning shared by the composer inline menu and the model modal:
// Recent on top, followed by provider-grouped sections sorted by name.
export function getProvider(m) {
  if (m.provider) return m.provider;
  if (m.id && m.id.includes("/")) return m.id.split("/")[0];
  return "";
}

export function formatProviderTitle(provider) {
  if (!provider) return "Other Models";
  if (provider === "profiles" || provider === "codex-profiles") return "Custom Profiles";
  if (provider === "opencode-go") return "OpenCode Go";
  if (provider === "opencode") return "OpenCode Zen";
  if (provider === "9router") return "9Router";
  if (provider === "google-antigravity") return "Google Antigravity";
  if (provider === "ollama-cloud") return "Ollama Cloud";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "openai") return "OpenAI";
  if (provider === "google") return "Google";
  return provider.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// sections: [{key, title, items}] — search keeps the same layout, fewer items per section.
export function buildModelSections(allModels, filteredModels, currentModel, query) {
  const source = query ? filteredModels : allModels;

  const sections = [];
  const recentItems = source
    .filter((m) => m.recent || m.id === currentModel)
    .sort((a, b) => (a.recentRank ?? 999) - (b.recentRank ?? 999));
  if (recentItems.length > 0) sections.push({ key: "recent", title: "Recent", items: recentItems });

  const recentIdSet = new Set(recentItems.map((m) => m.id));
  const nonRecent = source.filter((m) => !recentIdSet.has(m.id));

  const byProvider = new Map();
  for (const m of nonRecent) {
    const p = getProvider(m) || "other";
    if (!byProvider.has(p)) byProvider.set(p, []);
    byProvider.get(p).push(m);
  }

  // Sort providers: Custom Profiles first, then opencode-go / opencode, then alphabetical
  const providerKeys = [...byProvider.keys()].sort((a, b) => {
    if (a === "profiles" || a === "codex-profiles") return -1;
    if (b === "profiles" || b === "codex-profiles") return 1;
    if (a === "opencode-go") return -1;
    if (b === "opencode-go") return 1;
    if (a === "opencode") return -1;
    if (b === "opencode") return 1;
    return a.localeCompare(b);
  });

  for (const p of providerKeys) {
    const items = byProvider.get(p) || [];
    if (items.length === 0) continue;

    items.sort((a, b) => (a.label || a.id).localeCompare(b.label || b.id));
    sections.push({
      key: p,
      title: formatProviderTitle(p),
      items
    });
  }

  return sections;
}
