// One scroll-up tap's fetch loop, out of the hook so it can be driven by a test.
//
// It lived inside useAiSession and was re-implemented by the test that was supposed to
// prove it — so the test passed while the real loop was stuck. Measured on a real chat:
// 0 of 76 prompts reachable. The rules below are the whole contract; the hook only wires
// them to the bus and the store.

// Chunks one tap may buy. A turn that reduces to almost nothing (a log made of tool
// events, no prose) would otherwise walk the whole thread in one tap — the fetch is
// bounded, the walk is not.
export const OLDER_MAX_CHUNKS = 8;

// How much rendered conversation ONE tap brings back. The wire budget (AI_REPLAY_BYTES) is
// spent on raw events, which serialize ~2.4x their text — a turn carrying a tool result
// measures tens of KB of events but reduces to one small row. Sized on the wire budget
// instead, a page bought a couple of rows while the list's own budget (128KB) grew by four
// times as much, so every tap fetched again and the thread crept upward a few rows at a
// time — measured 24 taps to reach the first message of an 8-turn chat.
export const OLDER_PAGE_BYTES = 128 * 1024;

/**
 * Page backwards from `startSeq` until the rendered budget is spent, the host runs out,
 * or the chunk ceiling is reached.
 *
 * The mark (`before`) advances on EVERY answered chunk, including one that reduces to no
 * rows at all — a chunk of harness records the pane has no card for (`edited_text_file`,
 * `hook_success`, `task_reminder`) is the common case, and ending the walk on it is what
 * made scroll-up a dead end: measured, 24 of 238 chunks on a real chat reduce to nothing.
 *
 * @param fetchChunk  async (beforeSeq) => { success, events, hasMore } | null (no ack)
 * @param reduceChunk (events, heldCount) => messages already reduced for the store
 * @returns { messages, before, hasMore, answered, chunks }
 */
export async function collectOlderPage({
  startSeq,
  fetchChunk,
  reduceChunk,
  maxChunks = OLDER_MAX_CHUNKS,
  pageBudget = OLDER_PAGE_BYTES,
  estimateBytes = () => 0
}) {
  let before = startSeq;
  let older = [];
  let bytes = 0;
  let hasMore = true;
  let chunks = 0;
  let answered = false;

  while (chunks < maxChunks) {
    const res = await fetchChunk(before);
    chunks++;
    // A timed-out ack is not an answer — keep the door open so the next scroll retries.
    // Only the host saying "no such session" (success:false) closes it.
    if (res == null) break;
    if (!res.success) { hasMore = false; break; }
    if (!res.events?.length) { hasMore = false; break; }
    answered = true;

    // Ids continue past everything already held — this tap's own pages included, or the
    // second chunk would re-mint the ids the first one just used.
    const page = reduceChunk(res.events, older.length);
    // Kept BEFORE the budget is judged, so the mark never runs ahead of what was actually
    // delivered — a chunk dropped after `before` moved past it could never be asked for again.
    older = [...page, ...older];
    bytes += page.reduce((n, m) => n + estimateBytes(m), 0);
    before = res.events[0].seq;
    hasMore = Boolean(res.hasMore);
    if (!hasMore || bytes >= pageBudget) break;
  }

  return { messages: older, before, hasMore, answered, chunks };
}
