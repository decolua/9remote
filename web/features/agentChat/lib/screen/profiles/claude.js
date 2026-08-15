// Claude Code's screen vocabulary — measured against live captures, not invented.
//
// Two signal families, deliberately redundant:
//   glyphs  — ⏺ opens a block, ⎿ a result, ❯ the input. Readable but version-fragile.
//   colour  — Claude paints its markers grey (fg 102) and spinner verbs warm (fg ~215).
//             Roles keep their colour across layout changes more reliably than glyphs.
// A line is claimed when the glyph appears; colour confirms it and boosts detection.
import { CliProfile } from "../CliProfile.js";

export const CLAUDE_COLORS = Object.freeze({
  markerGrey: 102,
  warm: 215,
});

// Fixed chrome — mode bar, notices, hint footers. Never conversation.
const STATUS_BAR_RE = /bypass permissions|accept edits on|plan mode on|Auto-update failed|claude doctor|shift\+tab|ctrl\+o to expand|\besc to (cancel|exit)\b/i;
const COLLAPSE_RE = /^…\s*\+(\d+)\s*lines/;
const SPINNER_RE = /^[✻✽✳✶✷✸✹✺✢·]\s*(?<verb>[A-Za-z]\w*)…/;
const TOOL_CALL_RE = /^\s*(?<tool>[A-Za-z][\w.-]*)\s*\((?<summary>[\s\S]*)$/;
const OPTION_AT_START_RE = /^\s*(?:❯|>)?\s*(\d)[.)]\s*(\S.*)$/;
const OPTION_AFTER_CARET_RE = /❯\s*(\d)[.)]\s*(\S.*)$/;
const DIFF_RE = /^(@@|\+{3}|-{3}|[+-]\S)/;

const numberedOption = (text) => {
  let m = text.match(OPTION_AT_START_RE);
  if (!m) m = text.match(OPTION_AFTER_CARET_RE);
  return m ? { index: parseInt(m[1], 10), label: m[2].trim() } : null;
};

export class ClaudeProfile extends CliProfile {
  static id = "claude";

  constructor() {
    super();

    this.detect = {
      // Distinct signals; several weak or one strong claim the screen.
      hints: [
        { weight: 3, test: (l) => l.text.startsWith("⏺") || /\s⏺\s/.test(l.text) },
        { weight: 3, test: (l) => /^\s*⎿/.test(l.text) },
        { weight: 2, test: (l) => l.fgRuns?.some((r) => r.fg === CLAUDE_COLORS.markerGrey && r.text.includes("⏺")) },
        { weight: 1, test: (l) => SPINNER_RE.test(l.text) },
        { weight: 1, test: (l) => STATUS_BAR_RE.test(l.text) },
        { weight: 1, test: (l) => l.text.startsWith("❯") },
      ],
      // Glyph + grey marker is proof alone (3+2); the rest need several hits.
      minWeight: 4,
    };

    this.fallback = { name: "textBlock" };

    this.rules = [
      {
        name: "statusBar",
        match: ({ text }) => (STATUS_BAR_RE.test(text) ? text : false),
        run: () => {},
      },
      {
        name: "collapse",
        // "… +N lines" — annotate the open block instead of appearing as a row.
        match: ({ text }) => {
          const m = text.match(COLLAPSE_RE);
          return m ? parseInt(m[1], 10) : false;
        },
        run: ({ payload, state }) => {
          const target = state.openTool || state.block || state.events[state.events.length - 1];
          if (target) target.truncated = payload;
        },
      },
      {
        name: "spinner",
        match: ({ text }) => {
          const m = text.match(SPINNER_RE);
          return m ? { verb: m.groups.verb } : false;
        },
        run: ({ payload, state, push }) => {
          state.closeBlock();
          state.openTool = null;
          push({ kind: "working", verb: payload.verb });
        },
      },
      {
        name: "menuStart",
        // A numbered row opens a menu when the held question sits right above it.
        match: ({ text, state }) => {
          const opt = numberedOption(text);
          return (!state.promptOptions && state.heldQuestion != null && opt) ? opt : false;
        },
        run: ({ payload, state }) => {
          state.promptOptions = [payload];
          state.openTool = null;
        },
      },
      {
        name: "menuOption",
        // Numbered rows, opened by an open menu or a caret mid-line.
        match: ({ text, state }) => {
          const opt = numberedOption(text);
          if (!opt) return false;
          return (state.promptOptions || /❯\s*\d[.)]/.test(text)) ? opt : false;
        },
        run: ({ payload, state }) => {
          state.promptOptions = state.promptOptions || [];
          state.promptOptions.push(payload);
          state.openTool = null;
        },
      },
      {
        name: "menuFooter",
        match: ({ text, state }) =>
          state.promptOptions && /enter\s*to\s*select|to\s*navigate|esc\s*to\s*cancel/i.test(text) ? text : false,
        run: ({ state, push }) => { state.flushPrompt(push); },
      },
      {
        name: "assistantTool",
        // The marker must ALSO be painted Claude-grey: the glyph alone is not proof
        // (other tools print "⏺"-like bullets in default colour).
        match: ({ text, line }) => {
          if (!text.startsWith("⏺")) return false;
          if (!line.fgRuns?.some((r) => r.fg === CLAUDE_COLORS.markerGrey && r.text.includes("⏺"))) return false;
          const body = text.slice(1).trim();
          const call = body.match(TOOL_CALL_RE);
          return call?.groups?.tool ? { tool: call.groups.tool, summary: (call.groups.summary || "").replace(/\)$/, "").trim() } : false;
        },
        run: ({ payload, state, push }) => {
          state.closeBlock();
          state.flushPrompt(push);
          const ev = { kind: "tool", tool: payload.tool, summary: payload.summary, status: null };
          push(ev);
          state.openTool = ev;
        },
      },
      {
        name: "assistantProse",
        match: ({ text, line }) => {
          if (!text.startsWith("⏺")) return false;
          if (!line.fgRuns?.some((r) => r.fg === CLAUDE_COLORS.markerGrey && r.text.includes("⏺"))) return false;
          return text.slice(1).trim();
        },
        run: ({ payload, state, push }) => {
          state.closeBlock();
          state.flushPrompt(push);
          state.openTool = null;
          if (payload) push({ kind: "assistant", text: payload });
        },
      },
      {
        name: "result",
        match: ({ text }) => (/^\s*⎿/.test(text) ? text.replace(/^\s*⎿\s*/, "") : false),
        run: ({ payload, state, push }) => {
          state.closeBlock();
          if (state.openTool) {
            const tool = state.openTool;
            tool.output = tool.output ? `${tool.output}\n${payload}` : payload;
            if (/waiting/i.test(payload)) tool.status = "running";
            else tool.status = tool.status || "done";
          } else {
            state.appendBlock(payload);
          }
        },
      },
      {
        name: "resultContinuation",
        // A wrapped output row belongs to the tool above it.
        match: ({ state }) => (state.openTool?.output != null ? true : false),
        run: ({ text, state }) => { state.openTool.output += `\n${text}`; },
      },
      {
        name: "diff",
        match: ({ text, state }) => (DIFF_RE.test(text) && !state.promptOptions ? text : false),
        run: ({ payload, state, push }) => {
          state.closeBlock();
          state.openTool = null;
          const last = state.events[state.events.length - 1];
          if (last?.kind === "diff") last.text += `\n${payload}`;
          else push({ kind: "diff", text: payload });
        },
      },
      {
        name: "input",
        match: ({ text }) => (text.startsWith("❯") ? text.slice(1).trim() : false),
        run: ({ payload, state, push }) => {
          state.closeBlock();
          state.flushPrompt(push);
          state.openTool = null;
          push({ kind: "input", text: payload });
        },
      },
    ];
  }
}
