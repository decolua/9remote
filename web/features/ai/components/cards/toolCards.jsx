"use client";

// Which card a tool renders as. This is the ONE place that knows — the timeline and the
// sub-agent card both used to carry their own `switch`, so a new tool family meant
// editing two components and remembering the second one existed.
//
// A tool with no entry here falls back to AiToolCard, which renders any call from its
// name, input and output. Category → card comes from each engine's tool map in
// `../../registry`; that map already absorbs every new tool name, so a family that needs
// no card of its own needs no change anywhere.
import { AiBashCard } from "./AiBashCard";
import { AiAgentCard } from "./AiAgentCard";
import { AiPlanModeCard } from "./AiPlanModeCard";
import { AiReviewCard } from "./AiReviewCard";
import { AiQuestionCard } from "./AiQuestionCard";
import { getToolCategory, getEngineConfig } from "../../registry";

// Each entry takes the uniform props every consumer has and adapts them to its own card,
// so the caller spreads nothing and knows nothing about the shape each card wants. The key
// comes from the call's own id — a card rendered inside a list needs one either way, and
// every tool on the wire carries it.
//
// The agent card imports renderToolCard back, to draw the calls its sub-agent made. That
// cycle is deliberate and safe: neither side reads the other at module scope, only inside
// a render, by which time both are bound. Registering the card from its own file instead
// was tried and is worse — a module nothing imports never runs, so the card silently
// stopped existing.
const CARDS = {
  bash: (tool, deferred) => <AiBashCard key={tool.id} {...tool} deferred={deferred} />,
  agent: (tool, deferred, { engine, workspacePath }) => (
    <AiAgentCard key={tool.id} {...tool} engine={engine} workspacePath={workspacePath} />
  ),
  plan: (tool) => <AiPlanModeCard key={tool.id} toolName={tool.name} input={tool.input} />,
  // A code review, in either direction — its own vocabulary, its own card.
  review: (tool) => <AiReviewCard key={tool.id} toolName={tool.name} input={tool.input} />,
  // Answered question — the host's tool output is the only record of the choice.
  // A rejected call carries no output, only a refusal message; feeding that in as
  // `answers` painted the green "Answered" view over a question nobody answered.
  // Display-only while running or outputless (engines with no permission gate): the
  // interactive card has no `onResolve` on this path and would render nothing.
  question: (tool, _deferred, ctx) => {
    if (tool.status === "running" || (!tool.output && !tool.error)) return null;
    // agy headless auto-skips a question within milliseconds — nothing can answer it —
    // so the CLI's own "User Skipped" record reads as the muted Skipped view, not Answered.
    const skipped = Boolean(getEngineConfig(ctx?.engine).headlessQuestions) && /user skipped/i.test(String(tool.output || ""));
    return (
      <AiQuestionCard
        key={tool.id}
        engine={ctx?.engine}
        questions={tool.input?.questions || []}
        answers={skipped || tool.error ? null : tool.output || ""}
        declined={skipped || Boolean(tool.error) || tool.status === "error"}
      />
    );
  }
};

/**
 * The card for a tool call, or null when the generic row is the right one. Returned as an
 * element, not a component type: a component looked up during render is a new type on
 * every pass, which remounts the card and drops its expanded state.
 */
export function renderToolCard(engine, tool, ctx = {}) {
  const make = CARDS[getToolCategory(engine, tool.name)];
  return make ? make(tool, ctx.deferred, { ...ctx, engine }) : null;
}
