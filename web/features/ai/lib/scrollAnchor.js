// Holding a reader in place when a page of OLDER turns is prepended above them.
//
// Two readings and one subtraction, as plain arithmetic so the rule can be tested without
// a browser. The pane owns the measurement; this owns what it means.
//
// Why not `scrollHeight` across the fetch — which is what this replaces: the correction
// used to be `scrollTop += (scrollHeight_after - scrollHeight_before)`, with the fetch
// awaited in between. Two things move `scrollHeight` in those seconds and neither is the
// page: the live turn keeps streaming text into the TAIL, and the browser re-clamps
// `scrollTop` when content is prepended. The whole delta was added, so the reader was
// carried down by whatever the tail had grown. On a phone one page is worth far fewer
// pixels than on a desktop, so the wrong part of the delta was the bigger part.
//
// What is read instead is an ANCHOR NODE — the spec's own idea (CSS Scroll Anchoring picks
// one and follows it). It has to be a content element, not the scroller: the scroller's box
// never moves, so measuring it measures nothing. A turn already on screen does move, by
// exactly what was inserted above it, and content growing BELOW it does not move it at all.

// Below this, the reader is at the bottom, where there is nothing to hold and the tail is
// where they want to be. Matches the pane's own at-bottom test.
const AT_BOTTOM_PX = 8;

/**
 * What the reader was looking at, taken BEFORE the DOM changes.
 *
 * `nodeTop` is the anchor node's offset from the TOP OF THE CONTENT — its viewport
 * position plus `scrollTop`. Content coordinates, not viewport ones: it survives the
 * correction being written, which is what makes the read-back afterwards meaningful.
 *
 * @param {{scrollTop:number, scrollHeight:number, clientHeight:number, nodeTop:number}} m
 * @returns {{nodeTop:number, scrollTop:number, atBottom:boolean}}
 */
export function anchorFrom({ scrollTop = 0, scrollHeight = 0, clientHeight = 0, nodeTop = 0 } = {}) {
  return {
    nodeTop,
    scrollTop,
    atBottom: scrollHeight - scrollTop - clientHeight < AT_BOTTOM_PX
  };
}

/**
 * The `scrollTop` that holds the reader where `anchor` found them, or null to leave the
 * scroller alone.
 *
 * The node has to land back at the viewport offset it had, and that offset is
 * `nodeTop - scrollTop`. So the new `scrollTop` is the new `nodeTop` minus it. Whatever the
 * page did BELOW the node is simply not in this arithmetic — the part the old delta got
 * wrong.
 *
 * There is deliberately no clamp to the scroll range and no read-back afterwards. Given a
 * node that only moves DOWN the content (which is what prepending does), the answer is
 * provably inside the range: the node's new position and the scroll height both grow by the
 * same amount, so the distance from the node to the end can only ever stay the same or
 * grow. A guard for a case the arithmetic already excludes is a guard nothing ever runs.
 *
 * @param {{nodeTop:number, scrollTop:number, atBottom:boolean}} anchor
 * @param {{scrollHeight:number, clientHeight:number, nodeTop:number}} now  read back after
 *        the DOM change, in the same units
 * @returns {number|null}
 */
export function anchoredScrollTop(anchor, { scrollHeight = 0, clientHeight = 0, nodeTop = 0 } = {}) {
  if (!anchor) return null;
  // At the bottom, the tail is the destination — a pane paging at open, or a reader who
  // never left. Re-pinned rather than corrected.
  if (anchor.atBottom) return scrollHeight;
  // The node did not move down the content: the page has not mounted yet, or it mounted
  // below the node. Leaving it alone is the whole point — the case the old delta got wrong.
  if (nodeTop <= anchor.nodeTop) return null;
  return Math.max(0, nodeTop - (anchor.nodeTop - anchor.scrollTop));
}
