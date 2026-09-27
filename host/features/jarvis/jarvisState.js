// Where the kanban board actually lives: the daemon's KV (survives an agent
// restart), with an in-process cache so reads never wait on IPC twice. Every
// mutation funnels through applyAndBroadcast — and through the queue inside it:
// a tool call and a user hand move can land together, and without single-flight
// each would read the same old board and one write would erase the other.
import { kvGet, kvSet } from "../terminal/ptyDaemonClient.js";
import { getIO } from "../../transport/server.js";
import { broadcast } from "../../transport/broadcast.js";
import { emptyBoard, applyKanbanAction, syncFleetCards } from "./jarvisKanban.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("jarvis");

// Injectable so tests run without a daemon; the real one is the default.
let kv = { get: kvGet, set: kvSet };
export function setBoardKvForTests(next) { kv = next; }

const KV_KEY = "jarvis:kanban";
let cache = null;
let chain = Promise.resolve();

export async function loadBoard() {
  if (cache) return cache;
  // A failed read must NOT poison the cache with an empty board — the next
  // write would persist that emptiness and wipe every task the daemon still
  // holds. Fail loudly instead; every caller has an error path.
  let stored = null;
  try { stored = await kv.get(KV_KEY); } catch (e) { throw new Error(`board read failed: ${e.message}`); }
  cache = stored && typeof stored === "object" && stored.tasks ? stored : emptyBoard();
  return cache;
}

export async function saveBoard(board) {
  cache = board;
  try { await kv.set(KV_KEY, board); } catch { /* daemon down: the cache still serves */ }
}

async function doApply(action, source) {
  const board = await loadBoard();
  const { board: next, error } = applyKanbanAction(board, action);
  if (error) return { error };
  // One audit line per mutation — when a card vanishes, the log says who.
  logger.info(`kanban ${action?.type} ${action?.taskId || action?.title || action?.sessionId || ""} ← ${source || "?"}`);
  await saveBoard(next);
  const io = getIO();
  if (io) broadcast(io, "jarvis:kanban", next);
  return { board: next };
}

/** Apply one action, persist, push to every web mirror — one door, one queue. */
export function applyAndBroadcast(action, source) {
  const run = () => doApply(action, source);
  const result = chain.then(run, run);
  // The chain swallows failures so one bad action cannot poison the queue; the
  // caller still sees its own outcome through `result`.
  chain = result.catch(() => {});
  return result;
}

/**
 * Fold a fleet snapshot into the auto cards — on the SAME queue as the actions.
 * A getState that loaded the board before a report landed and saved after it
 * would erase that report; serializing the fold with every write closes the window.
 * Returns the folded board; `fleet` is passed in so this stays IO-free.
 */
export function foldFleetIntoBoard(fleet) {
  const run = async () => {
    const board = await loadBoard();
    const synced = syncFleetCards(board, fleet);
    if (synced.changed) await saveBoard(synced.board);
    return synced.board;
  };
  const result = chain.then(run, run);
  chain = result.catch(() => {});
  return result;
}

/** Test/rebuild hook — drops the cache so the next load re-reads the daemon. */
export function resetBoardCache() {
  cache = null;
}
