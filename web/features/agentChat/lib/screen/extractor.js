// Runs a profile's ordered rules over the screen lines → JSON events.
//
// The pipeline is CLI-agnostic: state machine and driver live here, vocabulary lives in
// the profile. One rule owns each line — the first match wins, fallback absorbs the rest
// into one text block.
export class ScreenEventExtractor {
  constructor(profile) {
    this.profile = profile;
  }

  /** Fresh per-run state; exposed so tests can probe rules against a clean slate. */
  newState(push = null) {
    const state = {
      events: [],
      openTool: null,       // tool event awaiting its result rows
      promptOptions: null,  // numbered menu being collected
      heldQuestion: null,   // "?" line a following menu may claim
      block: null,          // open text block absorbing consecutive unknown rows
    };
    state.push = (ev) => { state.closeBlock(); state.events.push(ev); };
    state.closeBlock = () => { state.block = null; };
    state.appendBlock = (text) => {
      if (state.block) state.block.text += `\n${text}`;
      else {
        state.block = { kind: this.profile.fallback ? "text" : "text", text };
        state.events.push(state.block);
      }
    };
    state.flushPrompt = (pushFn) => {
      if (!state.promptOptions) return;
      (pushFn || state.push)({ kind: "prompt", question: state.heldQuestion, options: state.promptOptions });
      state.promptOptions = null;
      state.heldQuestion = null;
    };
    if (push) state.push = push;
    return state;
  }

  extract(lines) {
    const state = this.newState();
    const rules = this.profile?.rules || [];
    const fallback = this.profile?.fallback;

    for (const line of lines) {
      const text = (line.text || "").trim();
      if (!text) continue;

      // A "?" row is held: the menu below may claim it as its question.
      if (!state.promptOptions && /\?\s*$/.test(text)) {
        state.closeBlock();
        state.openTool = null;
        if (state.heldQuestion != null) state.appendBlock(state.heldQuestion);
        state.heldQuestion = text;
        continue;
      }

      const ctx = { line, text, raw: line.text || "", state, push: state.push };
      let matched = false;
      for (const rule of rules) {
        let payload = false;
        try { payload = rule.match(ctx); } catch { payload = false; }
        if (payload === false) continue;
        rule.run({ ...ctx, payload });
        matched = true;
        break;
      }
      if (matched) continue;

      // A non-numbered row ends an unflushed menu.
      if (state.promptOptions) state.flushPrompt(state.push);

      if (fallback) state.appendBlock(text);
    }

    state.flushPrompt(state.push);
    if (state.heldQuestion != null) state.appendBlock(state.heldQuestion);
    return state.events;
  }
}
