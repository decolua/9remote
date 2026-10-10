// Agent tabs for one workspace's strip. The host stamps each agent tab with the
// workspace of the terminal session that opened it; a tab with no known owner (agent
// run from a shell outside the app) stays visible everywhere so it is never lost.
export function agentTabsForWorkspace(agentTabs, { wsKey, profile, ownTabs }) {
  if (!Array.isArray(agentTabs)) return [];
  return agentTabs.filter((t) => {
    if (t.workspaceId && t.workspaceId !== wsKey) return false;
    return !(t.profile === profile && ownTabs.some((b) => b.id === t.id));
  });
}
