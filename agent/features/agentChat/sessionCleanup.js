// Drop everything the chat layer holds for a pane. Called when a terminal session is
// deleted — without this the in-memory timeline and the on-disk mapping outlive the PTY,
// and the mapping file grows for the life of the install.
import { resetSession } from "./promptStore.js";
import { clearMapping } from "../terminal/agentSessionMap.js";
import { forgetScreen } from "../terminal/screenMirror.js";

export function forgetSession(sessionId) {
  if (!sessionId) return;
  resetSession(sessionId);
  clearMapping(sessionId);
  forgetScreen(sessionId);
}
