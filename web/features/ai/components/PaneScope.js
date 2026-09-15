"use client";

import { createContext, useContext } from "react";

/**
 * Which pane a card belongs to.
 *
 * Cards sit several memoized layers below the pane, and both readers of this scope are
 * document-wide: the strip's `getElementById` and the question card's `keydown` on
 * `window`. Neither can tell a sibling pane's card from its own, because tool ids are the
 * host's and two chats have never agreed to keep them apart — a codex rollout restarting
 * its numbering, a resumed conversation replaying, or simply the same tool called first in
 * both. Every pane stays mounted (hidden, not unmounted), so a bare `shell-<id>` could name
 * two elements and `getElementById` returned whichever rendered first. Same for the keys:
 * two panes holding a gate both answered one keypress.
 *
 * The pane owns the identity; the cards read it.
 *
 * Default is a lone pane: no sibling to collide with, nothing to steal focus from, and
 * nobody to activate.
 */
export const AiPaneScope = createContext({ sessionId: "", isFocused: true, activate: null });

export const useAiPaneScope = () => useContext(AiPaneScope);

/** The DOM anchor a card is scrolled to, namespaced by the pane that owns it. */
export const anchorId = (sessionId, kind, id) => (id ? `ai-${sessionId}-${kind}-${id}` : undefined);
