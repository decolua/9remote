// Per-CLI screen vocabulary. The parser pipeline is generic; a CLI plugs in by declaring
// its glyphs and shapes here, never by rewriting the pipeline.
//
// Everything is optional — a missing field means "this CLI does not have that concept".

/** Shared option-menu shape: footer lines every selector prints, any language. */
const selectorFooter = [/enter\s*to\s*select/i, /esc\s*to\s*cancel/i, /to\s*navigate/i];

export const CLAUDE_PROFILE = Object.freeze({
  id: "claude",

  markers: Object.freeze({
    // Turn structure
    assistant: "⏺",        // opens an assistant block (prose or a tool call)
    result: "⎿",           // opens a result/nested line under the block above
    input: "❯",            // the user input line
    spinner: /[✻✽✼✻✶✷✸✹✺✻✽✾✿❋❊❉❈❇❆❅❄❃❂❁✢✡✠✚✕✖✗]/,
    runningHint: /waiting|running|\.\.\.$/i,
    errorHint: /✗|failed|error/i,
  }),

  // Footer wording that identifies a selector regardless of the question's language.
  selectorFooter,

  // A tool call renders as "⏺ Tool(summary…)". The closing ")" is optional: the terminal
  // truncates long summaries with "…" before it, so requiring ")" misses real calls.
  toolCall: /^\s*(?<tool>[A-Za-z][\w.-]*)\s*\((?<summary>[\s\S]*)$/,
  toolCallBare: /^\s*(?<tool>[A-Za-z][\w.-]*)\s*$/,

  // Spinner line: "✻ Verb… (12s · 300 tokens)"
  spinnerLine: /^[✻✽✳✶✷✸✹✺✢·]\s*(?<verb>[A-Za-z]\w*)…/,

  // Anything else after the assistant marker is prose.
  fallbackKind: "text",
});

// Minimal profile for a CLI with none of Claude's glyphs: everything parses, nothing
// extracts. Proves the pipeline is driven by the profile, not by hardcoded glyphs.
export const GENERIC_PROFILE = Object.freeze({
  id: "generic",
  markers: Object.freeze({}),
  selectorFooter,
  fallbackKind: "text",
});
