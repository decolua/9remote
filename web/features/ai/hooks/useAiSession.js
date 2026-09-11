"use client";

import { useEffect, useRef, useCallback } from "react";
import { useAiStore } from "@/shared/stores/aiStore";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { parseEngineTaskEvent, parseEngineTaskResult } from "../registry";

const DEFAULT_STATS = { inputTokens: 0, outputTokens: 0, totalTurns: 0 };
const DEFAULT_METADATA = { model: "" };

// The CLI reports skills as bare id strings; the agent-side scan reports objects.
// Normalize both to one shape so the "/" menu and skills modal never render `undefined`.
const normalizeSkills = (skills) =>
  Array.isArray(skills)
    ? skills.map((s) => (typeof s === "string" ? { id: s, name: s, description: "" } : s))
    : [];
const EMPTY_MESSAGES = [];
// How long live events are held while waiting for the ai:create snapshot ack.
const HYDRATE_TIMEOUT_MS = 4000;

export function useAiSession({
  sessionId,
  engine = "claude",
  workspacePath = "",
  bus = null
}) {
  const busRef = useRef(bus);
  useEffect(() => {
    busRef.current = bus;
  }, [bus]);

  const initSession = useAiStore((s) => s.initSession);
  const setMetadata = useAiStore((s) => s.setMetadata);
  const appendDelta = useAiStore((s) => s.appendDelta);
  const appendThinking = useAiStore((s) => s.appendThinking);
  const appendDiff = useAiStore((s) => s.appendDiff);
  const appendTool = useAiStore((s) => s.appendTool);
  const updateToolResult = useAiStore((s) => s.updateToolResult);
  const upsertTask = useAiStore((s) => s.upsertTask);
  const setPermission = useAiStore((s) => s.setPermission);
  const clearPermission = useAiStore((s) => s.clearPermission);
  const finishTurn = useAiStore((s) => s.finishTurn);
  const setTurnRunning = useAiStore((s) => s.setTurnRunning);
  const addUserMessage = useAiStore((s) => s.addUserMessage);

  // Read session-specific state from Zustand
  const sessionState = useAiStore((s) => s.bySession[sessionId]);
  const messages = sessionState?.messages || EMPTY_MESSAGES;
  const isTurnRunning = sessionState?.isTurnRunning || false;
  const stats = sessionState?.stats || DEFAULT_STATS;
  const metadata = sessionState?.metadata || DEFAULT_METADATA;

  // One reducer for BOTH live events and join-replay — the host (daemon) is the
  // single source of truth, so replayed history must land in the same store
  // actions a live event would.
  const applyEvent = useCallback((sid, event, data) => {
    switch (event) {
      case "user_message":
        addUserMessage(sid, data.text);
        break;
      case "init": {
        // The agent-side scan (with descriptions) and the CLI's init both land here.
        // Keep the richer entry when the CLI's bare id arrives second.
        // Current may still hold raw strings from state persisted before this normalization
        const current = normalizeSkills(useAiStore.getState().bySession[sid]?.metadata?.skills);
        const byId = new Map(current.map((s) => [s.id || s.name, s]));
        const skills = normalizeSkills(data.skills).map((s) => {
          const known = byId.get(s.id);
          return known?.description ? { ...s, description: known.description } : s;
        });
        setMetadata(sid, { ...data, skills });
        break;
      }
      case "delta":
        appendDelta(sid, data.text);
        break;
      case "thinking":
        appendThinking(sid, data.text);
        break;
      case "diff":
        appendDiff(sid, data);
        break;
      case "tool_start":
        appendTool(sid, data);
        if (data && data.name) {
          const currentTasks = useAiStore.getState().bySession[sid]?.tasks || [];
          const task = parseEngineTaskEvent(engine, data.name, data.input, data.id, currentTasks);
          if (task) {
            upsertTask(sid, task);
          }
        }
        break;
      case "tool_result":
        updateToolResult(sid, data);
        if (data && data.id) {
          const taskRes = parseEngineTaskResult(engine, data.name || "", data.output || "", data.id);
          if (taskRes) {
            upsertTask(sid, taskRes);
          }
        }
        break;
      case "permission_request":
        setPermission(sid, data);
        break;
      case "permission_resolved":
        // Another surface (or a replay) closed this gate — drop the card here too
        clearPermission(sid, data.requestId);
        break;
      case "options_changed":
        // Another surface switched mode/model — this one shows the same thing
        if (data?.permissionMode) useAiStore.getState().setPermissionMode(sid, data.permissionMode);
        if (data?.model) setMetadata(sid, { model: data.model });
        break;
      case "turn_complete":
        finishTurn(sid, data.stats);
        break;
      case "stopped":
        setTurnRunning(sid, false);
        break;
      case "error":
        // Spawn/CLI failure never produces a turn_complete — surface it as text
        // and release the turn, or the pane spins on a process that is gone.
        appendDelta(sid, `\n\n**Error:** ${data?.message || "AI process failed"}`);
        finishTurn(sid);
        break;
      case "conversation_reset":
        useAiStore.getState().clearMessages(sid);
        break;
      default:
        break;
    }
  }, [engine, addUserMessage, setMetadata, appendDelta, appendThinking, appendDiff, appendTool, updateToolResult, upsertTask, setPermission, clearPermission, finishTurn, setTurnRunning]);

  // applyEvent changes identity whenever its store actions do; the hydrate effect
  // below must NOT re-run for that — re-emitting ai:create would truncate and
  // replay over a session that is mid-stream.
  const applyEventRef = useRef(applyEvent);
  useEffect(() => { applyEventRef.current = applyEvent; });

  // Highest host seq this client has applied. Events at or below it are already
  // folded in (replayed or live) and must not be applied twice.
  const appliedSeqRef = useRef(0);
  // Live events that arrive between emitting ai:create and its ack. The ack
  // resets the store and replays the snapshot, so anything applied in that window
  // would be wiped — hold them and re-apply after the replay, in order. This is
  // the AI counterpart of the terminal's "replay before live output" ordering.
  const hydratingRef = useRef(false);
  const pendingLiveRef = useRef([]);
  // Bumped per hydrate attempt. StrictMode mounts twice and the first ack must not
  // release the gate the second attempt is still holding — a stale callback stands
  // down instead of clearing state a newer cycle owns.
  const hydrateSeqRef = useRef(0);

  // 1. Initialize session in store and on host agent. The ack carries the host's
  // full event log — the host is authoritative, so a client rebuilds its view
  // from it (truncate then replay) rather than trusting its own localStorage.
  // That is what makes web 3000 / agent UI / mobile show one identical history.
  useEffect(() => {
    if (!sessionId) return;
    initSession(sessionId);
    if (!bus) return;
    const gen = ++hydrateSeqRef.current;
    hydratingRef.current = true;
    pendingLiveRef.current = [];
    // Drains the held events in arrival order, skipping any the snapshot covers.
    const releaseHeld = () => {
      const queued = pendingLiveRef.current;
      pendingLiveRef.current = [];
      hydratingRef.current = false;
      for (const p of queued) {
        if (p.seq != null) {
          if (p.seq <= appliedSeqRef.current) continue;
          appliedSeqRef.current = p.seq;
        }
        applyEventRef.current(sessionId, p.event, p.data);
      }
    };
    // A lost ack (carrier dropped mid-flight) must not leave the gate shut forever
    // — that would buffer every later live event and freeze the chat for good.
    // Past this window the snapshot is stale anyway and live events are newer.
    const releaseTimer = setTimeout(() => {
      if (gen !== hydrateSeqRef.current || !hydratingRef.current) return;
      releaseHeld();
    }, HYDRATE_TIMEOUT_MS);
    bus.emit("ai:create", { sessionId, engine, cwd: workspacePath }, (res) => {
      // A newer hydrate (StrictMode remount) owns the gate now — stand down.
      if (gen !== hydrateSeqRef.current) return;
      const events = res?.session?.events;
      try {
        clearTimeout(releaseTimer);
        // `session` is daemon-only. The in-agent engines answer without one (they
        // hold no replayable log), so this is a no-op hydrate for them — the drain
        // in the finally still runs.
        if (!res?.ok || !Array.isArray(events)) return;
        const snapshotSeq = res.session.seq || 0;
        // An empty host log means the host has nothing for this session yet (fresh
        // one, or a legacy session created before the daemon owned state). Leave
        // whatever the client already has instead of blanking it.
        if (events.length > 0) {
          // Idempotent: StrictMode double-mount replays to the same result
          useAiStore.getState().clearMessages(sessionId);
          for (const ev of events) {
            applyEventRef.current(sessionId, ev.event, ev.data);
          }
        }
        // Watermark after the replay: it only ever moves forward.
        appliedSeqRef.current = Math.max(appliedSeqRef.current, snapshotSeq);
        // The host owns turn state and the permission mode (it spawns the CLI with
        // it). Set both from the snapshot, then drain (in the finally): a queued
        // turn_complete / user_message re-sets turn state in order, so the newest
        // event wins. (Removing the optimistic addUserMessage means those events
        // are the only writers, which is what keeps two clients agreeing.)
        setTurnRunning(sessionId, Boolean(res.session.isTurnRunning));
        if (res.session.permissionMode) {
          useAiStore.getState().setPermissionMode(sessionId, res.session.permissionMode);
        }
      } finally {
        // Always drains — a failed ack must not discard events that really arrived.
        clearTimeout(releaseTimer);
        if (gen === hydrateSeqRef.current) releaseHeld();
      }
    });
    return () => clearTimeout(releaseTimer);
  }, [sessionId, engine, workspacePath, bus, initSession, setTurnRunning]);

  // 2. Subscribe to AI bus events
  useEffect(() => {
    if (!bus || !sessionId) return;

    const handleAiEvent = (payload) => {
      if (!payload || payload.sessionId !== sessionId) return;
      // Mid-hydrate: the store is about to be reset and replayed, so applying now
      // would be thrown away. Hold it; the ack drains this queue after the replay.
      if (hydratingRef.current) {
        pendingLiveRef.current.push(payload);
        return;
      }
      // Already covered by a replay this client hydrated from — applying it again
      // would duplicate the message. Unstamped (legacy in-agent) events pass.
      if (payload.seq != null) {
        if (payload.seq <= appliedSeqRef.current) return;
        appliedSeqRef.current = payload.seq;
      }
      applyEvent(sessionId, payload.event, payload.data);
    };

    bus.on("ai:event", handleAiEvent);
    return () => {
      bus.off("ai:event", handleAiEvent);
    };
  }, [bus, sessionId, applyEvent]);

  // 3. User actions
  const sendPrompt = useCallback(
    (text) => {
      if (!text) return;
      // Read the turn state live, not from this render's closure: the queue drain
      // calls us right after stop(), while the memoized closure still says running —
      // bailing on that stale flag silently dropped the queued prompt.
      const running = useAiStore.getState().bySession[sessionId]?.isTurnRunning;
      if (running) return;
      const b = busRef.current || useConnectionStore.getState().bus;
      // No ai:create here: the host auto-creates on prompt, and the mount effect
      // already hydrated this session. Re-emitting it per message would make the
      // host serialize and ship the entire event log back on every keystroke-send.
      // No optimistic user message either: the host echoes "user_message" to every
      // client (including us), which is what keeps surfaces in lockstep.
      b?.emit("ai:prompt", { sessionId, message: text, cwd: workspacePath });
    },
    [sessionId, workspacePath]
  );

  const resolvePermission = useCallback(
    (requestId, behavior, message = "", answers = null) => {
      clearPermission(sessionId, requestId);
      const b = busRef.current || useConnectionStore.getState().bus;
      if (answers) {
        b?.emit("ai:question", { sessionId, requestId, answers });
      } else {
        b?.emit("ai:permission", { sessionId, requestId, behavior, message });
      }
    },
    [sessionId, clearPermission]
  );

  const stop = useCallback(() => {
    const b = busRef.current || useConnectionStore.getState().bus;
    b?.emit("ai:stop", { sessionId });
    setTurnRunning(sessionId, false);
  }, [sessionId, setTurnRunning]);

  const runShell = useCallback(
    (command) => {
      sendPrompt(`! ${command}`);
    },
    [sendPrompt]
  );

  const rewindToMessage = useCallback(
    (messageId, newText) => {
      // Truncate to message; optionally re-submit the edited text as a new prompt.
      // The host echoes "user_message" back, so no local optimistic add here.
      useAiStore.getState().rewindToMessage(sessionId, messageId, newText);
      if (newText) {
        const b = busRef.current || useConnectionStore.getState().bus;
        b?.emit("ai:prompt", { sessionId, message: newText, cwd: workspacePath });
      }
    },
    [sessionId, workspacePath]
  );

  return {
    messages,
    isTurnRunning,
    stats,
    metadata,
    sendPrompt,
    resolvePermission,
    stop,
    runShell,
    rewindToMessage
  };
}
