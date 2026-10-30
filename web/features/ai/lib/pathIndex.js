// Client-side cache for the workspace path index behind `@` mentions. One fetch per
// workspace per TTL; concurrent keystrokes share the in-flight request instead of
// each emitting `ai:files`.
//
// The host ships `paths` + `modified` (indices into `paths`) because the reply has to
// fit one control message. A big repo gets a trimmed index; when that index cannot
// answer a query, ask the host to search rather than showing nothing.
const TTL_MS = 30 * 1000;

const cache = new Map();
const inflight = new Map();

const emitFiles = (bus, payload) => new Promise((resolve) => {
  bus.emit("ai:files", payload, (res) => resolve(res?.ok ? res : null));
});

function toIndex(res) {
  if (!res) return null;
  const modified = new Set(res.modified || []);
  return {
    files: (res.paths || []).map((path, i) => ({ path, isModified: modified.has(i) })),
    dirs: res.dirs || [],
    truncated: !!res.truncated
  };
}

export function getPathIndex(bus, workspace) {
  if (!bus?.emit || !workspace) return Promise.resolve(null);

  const hit = cache.get(workspace);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.index);

  const pending = inflight.get(workspace);
  if (pending) return pending;

  const request = emitFiles(bus, { workspace }).then((res) => {
    inflight.delete(workspace);
    const index = toIndex(res);
    if (index) cache.set(workspace, { index, at: Date.now() });
    return index;
  });
  inflight.set(workspace, request);
  return request;
}

// Host-side search, for a query the trimmed index could not resolve.
export function searchPathIndex(bus, workspace, query) {
  if (!bus?.emit || !workspace || !query) return Promise.resolve(null);
  return emitFiles(bus, { workspace, query }).then(toIndex);
}
