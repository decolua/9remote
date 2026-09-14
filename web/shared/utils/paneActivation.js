// Pointer handling for a workspace pane. A pane activates on pointer-down anywhere in
// it, which is what you want on empty space and wrong on a control: activating focuses
// the pane's input, so tapping a button pulled focus out of the box you were typing in.
// A mouse-down that is not defaulted also blurs whatever held focus, which is how a tap
// on a chip closed the soft keyboard.
const CONTROL_SELECTOR = [
  "button", "a", "label", "select", "[role='dialog']", "[data-pane-control]"
].join(",");

// Fields keep their default: preventing it there would block the focus they exist for.
const FIELD_SELECTOR = "input, textarea";

export function panePointerHandler(e, { isFocused, onActivate }) {
  const target = e.target;
  if (target?.closest?.(CONTROL_SELECTOR)) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  // Touch only: without this a tap on dead space blurs the box and drops the soft
  // keyboard. A mouse-down is left alone so drag-to-select text still works.
  if (e.type === "touchstart" && !target?.closest?.(FIELD_SELECTOR)) e.preventDefault();
  // An empty pane is a request to be the active one; a focused pane is already there,
  // and re-activating on every click would fight with whatever the pointer is doing.
  if (isFocused) return;
  onActivate?.();
}

export function makePanePointerHandlers({ isFocused, onActivate }) {
  const handle = (e) => panePointerHandler(e, { isFocused, onActivate });
  return { onMouseDown: handle, onTouchStart: handle };
}
