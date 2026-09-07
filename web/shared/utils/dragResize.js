// Shared pointer-drag plumbing for the layout splitters (sidebar, panes, right panel,
// editor panel, mobile panel).
//
// Why it exists: pointermove fires faster than the display refreshes — on a 120Hz trackpad
// roughly twice per frame — and each event used to call a store setter directly. Every one
// of those re-rendered the whole terminal view AND (before the persist debounce) serialized
// the store to localStorage. Coalescing to one commit per animation frame keeps the drag at
// display rate without changing WHAT is committed: the same setter, the same clamping in the
// store, so `autoWidth` and `fitPaneWidth` still read a value that matches the DOM.
//
// Deliberately NOT bypassing React to write el.style.width during the drag: pane and sidebar
// widths feed the auto-width formula and the PTY cols gate, and a DOM value the store has not
// seen yet would desync them.

// Width the element should take for a pointer now at `x`.
// `axis` is +1 when dragging right widens the element (sidebar, panes) and -1 when it is the
// element's left edge being dragged (right/editor/mobile panels, which grow leftward).
// Clamping stays in the store so every entry point — drag, double-click fit, rehydrate —
// goes through one set of bounds.
export const widthAt = ({ startWidth, startX, x, axis = 1 }) => startWidth + axis * (x - startX);

// Track one horizontal splitter drag, emitting at most once per animation frame.
export function startWidthDrag(event, { startWidth, axis = 1, onWidth, onEnd }) {
  event.preventDefault();
  const startX = event.clientX;
  let pendingX = startX;
  let rafId = null;

  const commit = () => {
    rafId = null;
    onWidth(widthAt({ startWidth, startX, x: pendingX, axis }));
  };

  const onMove = (ev) => {
    // If buttons is 0, mouse/trackpad was released but pointerup was dropped by WebKit
    if (ev.buttons === 0) {
      onUp();
      return;
    }
    pendingX = ev.clientX;
    if (rafId === null) rafId = requestAnimationFrame(commit);
  };

  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    // A frame may still be queued with the last position — land it rather than
    // dropping the final pixels of the drag.
    if (rafId !== null) { cancelAnimationFrame(rafId); commit(); }
    onEnd?.();
  };

  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}
