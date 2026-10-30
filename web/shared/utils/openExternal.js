// In Tauri, target=_blank opens another webview window (looks like the app
// again) — hand external links to the system browser via the opener plugin.
export function openExternal(e, href) {
  const opener = window.__TAURI__?.opener;
  if (!opener?.openUrl) return; // plain browser: let the <a> do its job
  e.preventDefault();
  opener.openUrl(href).catch(() => {});
}
