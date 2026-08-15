// Terminal-screen parser: raw PTY bytes → the text the screen actually shows →
// provider-neutral JSON events.
//
// Two stages, deliberately separate:
//   parseScreen(bytes, profile)    — run a tiny terminal emulator; returns screen text.
//   applyScreenStream(text, profile) — read that text with the CLI's markers; returns events.
// The grid is universal; the markers live in cliProfiles.js so another CLI plugs in by
// declaring its glyphs instead of touching this pipeline.
//
// Known limits (accepted): the screen holds only the current frame — scrolled-off content
// is gone, and text the CLI truncated with "…" before printing cannot be recovered.

// ── Stage 1: the grid ─────────────────────────────────────────────────────────

const TOKEN_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[([0-9;?]*)([A-Za-z])|\x1b./s;

const cell = (rows, r) => {
  while (rows.length <= r) rows.push([]);
  return rows[r];
};

/**
 * A minimal terminal: rows×cols of text, cursor motion, erase, alt-screen.
 * Returns the visible screen as newline-joined text.
 */
export function parseScreen(bytes) {
  const rows = [];
  const cur = { r: 0, c: 0 };
  let alt = false;

  const text = String(bytes ?? "");
  const put = (glyph) => {
    const row = cell(rows, cur.r);
    while (row.length < cur.c) row.push(" ");
    row[cur.c] = glyph;
    cur.c++;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === "\n") { cur.r++; cur.c = 0; i++; continue; }
    if (ch === "\r") { cur.c = 0; i++; continue; }
    if (ch === "\b") { cur.c = Math.max(0, cur.c - 1); i++; continue; }
    if (ch === "\t") { put(" "); put(" "); put(" "); put(" "); i++; continue; }

    if (ch === "\x1b") {
      const m = text.slice(i).match(TOKEN_RE);
      if (!m) break;   // lone ESC at the end of the stream — nothing more to do
      i += m[0].length;
      if (m[2] !== undefined) applyControl(m[1] || "", m[2], rows, cur, (v) => { alt = v; });
      continue;
    }

    put(ch);
    i++;
  }

  return rows.map((row) => row.join("").replace(/ +$/, "")).join("\n").replace(/\n+$/, "");
}

// CSI interpreter. `raw` is the parameter string (may start with ? for private modes).
function applyControl(raw, cmd, rows, cur, setAlt) {
  // Private-mode marker: strip a leading ? so "?1049" → "1049".
  const privateMode = raw.startsWith("?");
  const nums = raw.replace(/^\?/, "").split(";").map((n) => (n === "" ? NaN : parseInt(n, 10)));
  const p = (idx, dflt) => (Number.isFinite(nums[idx]) ? nums[idx] : dflt);

  switch (cmd) {
    case "A": cur.r = Math.max(0, cur.r - p(0, 1)); break;
    case "B": cur.r += p(0, 1); break;
    case "C": cur.c += p(0, 1); break;
    case "D": cur.c = Math.max(0, cur.c - p(0, 1)); break;
    case "E": cur.r += p(0, 1); cur.c = 0; break;
    case "F": cur.r = Math.max(0, cur.r - p(0, 1)); cur.c = 0; break;
    case "G": cur.c = Math.max(0, p(0, 1) - 1); break;
    case "H": case "f":
      cur.r = Math.max(0, p(0, 1) - 1);
      cur.c = Math.max(0, p(1, 1) - 1);
      break;
    case "J": {
      const n = p(0, 0);
      if (n === 2 || n === 3) rows.length = 0;               // whole screen (cursor keeps)
      else if (n === 0) {                                     // cursor → end of screen
        cell(rows, cur.r).length = cur.c;
        for (let i = cur.r + 1; i < rows.length; i++) rows[i] = [];
      } else if (n === 1) {                                   // start → cursor
        for (let i = 0; i < cur.r; i++) rows[i] = [];
        const row = cell(rows, cur.r);
        for (let i = 0; i <= cur.c && i < row.length; i++) row[i] = " ";
      }
      break;
    }
    case "K": {
      const n = p(0, 0);
      const row = cell(rows, cur.r);
      if (n === 0) row.length = cur.c;
      else if (n === 1) { for (let i = 0; i <= cur.c && i < row.length; i++) row[i] = " "; }
      else row.length = 0;
      break;
    }
    case "h": case "l": {
      if (privateMode) {
        for (const n of nums) {
          if (n === 1049 || n === 1047) {
            // Alt-screen switch: the main grid and the TUI grid are separate worlds.
            setAlt(cmd === "h");
            rows.length = 0;
            cur.r = 0; cur.c = 0;
          }
          // 25 cursor visibility, 1000-1015 mouse, 2004 bracketed paste: no grid impact
        }
      }
      break;
    }
    default: break;   // SGR colours, DECSTBM scroll regions, save/restore — no text impact
  }
}

// ── Stage 2: events from screen text ──────────────────────────────────────────

const numberedOption = (line) => {
  // Normal shape: the number opens the line. Reflow shape: the question, the caret and
  // option 1 landed on one row — there the caret mid-line marks the option.
  let m = line.match(/^\s*(?:❯|>)?\s*(\d)[.)]\s*(\S.*)$/);
  if (!m) m = line.match(/❯\s*(\d)[.)]\s*(\S.*)$/);
  return m ? { index: parseInt(m[1], 10), label: m[2].trim() } : null;
};

// A caret mid-line before a number is a strong enough selector signal on its own —
// no footer needed to start collecting.
const isMidLineOption = (line) => /❯\s*\d[.)]\s*\S/.test(line);

/**
 * Read the reconstructed screen with a CLI profile and return ordered events:
 *   { kind: "assistant"|"tool"|"input"|"working"|"prompt"|"text", ... }
 * Provider-neutral — the glyphs come from the profile.
 */
/**
 * Line rules: ordered data-driven classifiers. Each rule declares what it matches and
 * what it emits; the driver below just walks them — adding a CLI means declaring its
 * markers in cliProfiles.js, not editing control flow here.
 * A rule's `match` returns a truthy payload (handed to `run`) or false.
 */
const RULES = [
  {
    name: "menuOption",
    match: ({ trimmed, state }) => {
      const opt = numberedOption(trimmed);
      if (!opt) return false;
      return (state.promptOptions || isMidLineOption(trimmed)) ? opt : false;
    },
    run: ({ payload, state }) => {
      if (!state.promptOptions) state.promptOptions = [];
      state.promptOptions.push(payload);
      state.openTool = null;
    },
  },
  {
    name: "menuStart",
    // A numbered row opens a menu only when a question sits right above it.
    match: ({ trimmed, raw, lines, state }) =>
      !state.promptOptions && numberedOption(trimmed) && looksLikeSelectorStart(lines, raw)
        ? numberedOption(trimmed) : false,
    run: ({ payload, state }) => {
      state.promptOptions = [payload];
      state.openTool = null;
    },
  },
  {
    name: "menuFooter",
    match: ({ trimmed, state, profile }) =>
      state.promptOptions && (profile.selectorFooter || []).some((re) => re.test(trimmed)) ? trimmed : false,
    run: ({ state }) => { state.flushPrompt(); },
  },
  {
    name: "spinner",
    match: ({ trimmed, profile }) => {
      if (!profile.spinnerLine) return false;
      const m = trimmed.match(profile.spinnerLine);
      return m ? { verb: m.groups?.verb || null } : false;
    },
    run: ({ payload, state, emit }) => {
      state.releaseQuestion();
      state.flushPrompt();
      emit({ kind: "working", verb: payload.verb });
      state.openTool = null;
    },
  },
  {
    name: "result",
    match: ({ trimmed, markers }) =>
      markers.result && trimmed.startsWith(markers.result)
        ? trimmed.slice(markers.result.length).trim() : false,
    run: ({ payload, state, emit, profile }) => {
      state.releaseQuestion();
      const text = payload;
      if (state.openTool) {
        const tool = state.openTool;
        tool.output = tool.output ? `${tool.output}\n${text}` : text;
        if (profile.markers?.errorHint?.test(text)) tool.status = "error";
        else if (tool.status !== "error" && /waiting/i.test(text)) tool.status = "running";
        else if (tool.status !== "error") tool.status = tool.status || "done";
      } else {
        emit({ kind: "text", text });
      }
    },
  },
  {
    name: "assistantTool",
    match: ({ trimmed, markers, profile }) => {
      if (!markers.assistant || !trimmed.startsWith(markers.assistant)) return false;
      const body = trimmed.slice(markers.assistant.length).trim();
      const call = body.match(profile.toolCall || /$^/);
      return call?.groups?.tool ? { tool: call.groups.tool, summary: (call.groups.summary || "").trim() } : false;
    },
    run: ({ payload, state, emit }) => {
      state.releaseQuestion();
      state.flushPrompt();
      const ev = { kind: "tool", tool: payload.tool, summary: payload.summary, status: null };
      emit(ev);
      state.openTool = ev;
    },
  },
  {
    name: "assistantBareTool",
    match: ({ trimmed, markers, profile }) => {
      if (!markers.assistant || !trimmed.startsWith(markers.assistant)) return false;
      const body = trimmed.slice(markers.assistant.length).trim();
      if (body.includes(" ")) return false;
      const bare = body.match(profile.toolCallBare || /$^/);
      return bare?.groups?.tool ? { tool: bare.groups.tool } : false;
    },
    run: ({ payload, state, emit }) => {
      state.releaseQuestion();
      state.flushPrompt();
      const ev = { kind: "tool", tool: payload.tool, summary: "", status: null };
      emit(ev);
      state.openTool = ev;
    },
  },
  {
    name: "assistantProse",
    match: ({ trimmed, markers }) =>
      markers.assistant && trimmed.startsWith(markers.assistant)
        ? trimmed.slice(markers.assistant.length).trim() : false,
    run: ({ payload, state, emit }) => {
      state.releaseQuestion();
      state.flushPrompt();
      state.openTool = null;
      if (payload) emit({ kind: "assistant", text: payload });
    },
  },
  {
    name: "input",
    match: ({ trimmed, markers }) =>
      markers.input && trimmed.startsWith(markers.input)
        ? trimmed.slice(markers.input.length).trim() : false,
    run: ({ payload, state, emit }) => {
      state.releaseQuestion();
      state.flushPrompt();
      state.openTool = null;
      emit({ kind: "input", text: payload });
    },
  },
  {
    name: "decoration",
    match: ({ trimmed }) => /^[─═━▔▁]+$/.test(trimmed) ? trimmed : false,
    run: () => {},
  },
  {
    name: "question",
    // Held, not emitted: a menu may claim it. Anything else releases it as text.
    match: ({ trimmed, state }) => !state.promptOptions && /\?\s*$/.test(trimmed) ? trimmed : false,
    run: ({ payload, state }) => {
      state.releaseQuestion();
      state.openTool = null;
      state.heldQuestion = payload;
    },
  },
  {
    name: "fallback",
    // Unknown shape stays as text — CLI updates add glyphs, and dropped lines hide
    // conversation.
    match: ({ profile }) => (profile.fallbackKind ? true : false),
    run: ({ trimmed, state, emit, profile }) => {
      state.releaseQuestion();
      state.flushPrompt();
      state.openTool = null;
      emit({ kind: profile.fallbackKind, text: trimmed });
    },
  },
];

export function applyScreenStream(screenText, profile) {
  if (!screenText) return [];
  const lines = String(screenText).split("\n");
  const markers = profile?.markers || {};
  const events = [];

  // A menu already collected but not yet footer-terminated ends here.
  const state = {
    openTool: null,      // last tool event, awaiting its result line
    promptOptions: null, // numbered menu being collected
    heldQuestion: null,  // a "?" line the following menu may claim
  };
  state.flushPrompt = () => {
    if (!state.promptOptions) return;
    events.push({ kind: "prompt", question: state.heldQuestion, options: state.promptOptions });
    state.promptOptions = null;
    state.heldQuestion = null;
  };
  state.releaseQuestion = () => {
    if (state.heldQuestion == null) return;
    events.push({ kind: "text", text: state.heldQuestion });
    state.heldQuestion = null;
  };

  const emit = (ev) => { events.push(ev); };

  for (const raw of lines) {
    const trimmed = raw.replace(/\s+$/, "").trim();
    if (!trimmed) continue;

    const ctx = { trimmed, raw, lines, markers, profile, state, emit };
    for (const rule of RULES) {
      const payload = rule.match(ctx);
      if (payload === false) continue;
      rule.run({ ...ctx, payload });
      break;
    }
  }
  // The prompt owns the held question; only a question no menu ever claimed is text.
  state.flushPrompt();
  state.releaseQuestion();
  return events;
}

// A numbered row only starts a menu when a question is right above it or a selector
// footer follows — `ls | cat -n` output must not read as a prompt.
function looksLikeSelectorStart(lines, currentRaw) {
  const idx = lines.indexOf(currentRaw);
  for (let back = 1; back <= 2 && idx - back >= 0; back++) {
    const prev = lines[idx - back]?.trim();
    if (!prev) continue;
    if (/\?\s*$/.test(prev)) return true;                                  // question above
    if (/enter\s*to\s*select|esc\s*to\s*cancel|to\s*navigate/i.test(prev)) return false;
  }
  return false;
}
