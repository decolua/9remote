// Chrome metrics shared by every workspace surface (terminal, file explorer, side
// panels). Kept here rather than per-feature so the bars actually line up: a header that
// is 2px taller than its neighbour is visible the moment two panels sit side by side.

// Every panel/tab header row. The terminal tab strip is the reference — its tabs are
// py-1.5 around a text-sm line box, i.e. 12 + 20 = 32px — and the file explorer, side
// panels and session list all match it so nothing shifts when switching views.
export const PANEL_HEADER_HEIGHT = 32; // px

// Same number as a Tailwind class, for headers that stay taller on mobile (thumb-sized
// targets) where an inline style cannot be made responsive.
export const PANEL_HEADER_H_CLASS = "sm:h-8";

// The single bottom status bar, spanning the full window under every view.
export const STATUS_BAR_HEIGHT = 26; // px
