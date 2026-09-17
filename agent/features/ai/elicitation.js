// An MCP elicitation request, as the question card reads it.
//
// `elicitation/create` lets an MCP server ask the user something, and it states the ask as
// a JSON Schema (`requestedSchema.properties`) rather than as a question list. The card
// wants `{questions: [{question, options[{label}]}]}`, so this is that one conversion —
// put here rather than in the card so both the question card and any later reader agree
// on what a schema means, and so it can be tested without a browser.
//
// Schema shapes are the MCP 2025-11-25 primitives, read off codex's own generated
// bindings (`McpElicitationPrimitiveSchema`): string, number/integer, boolean, and the
// enum families (`enum: string[]`, `oneOf: [{const, title}]`, and the multi-select
// variants whose `items` hold the same two).
//
// A property with NO options (a free string, a number, a boolean) becomes a question with
// no choices, which is exactly what the card's own free-text box is for.
export function elicitationQuestions(params = {}) {
  const props = params.requestedSchema?.properties || {};
  const required = new Set(params.requestedSchema?.required || []);
  const out = [];
  for (const [key, schema] of Object.entries(props)) {
    const question = schema?.title || schema?.description || key;
    const options = schemaOptions(schema);
    out.push({
      id: key,
      header: schema?.title || key,
      question,
      // The card's contract, and the server's: whether the user may type instead.
      isOther: options.length === 0,
      isSecret: schema?.format === "password",
      // A multi-select property is the one the card renders as a toggle list rather than a
      // radio row — its own field, and the reason `items` is read above.
      multiSelect: schema?.type === "array",
      options: options.length ? options.map((label) => ({ label, description: "" })) : null,
      ...(required.has(key) ? { required: true } : null)
    });
  }
  return out;
}

/** Every choice a property offers, across the schema families that have any. */
function schemaOptions(schema = {}) {
  if (Array.isArray(schema.enum)) return schema.enum.map(String);
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map((o) => String(o?.title ?? o?.const ?? "")).filter(Boolean);
  // Multi-select nests the same two under `items`.
  const items = schema.items || {};
  if (Array.isArray(items.enum)) return items.enum.map(String);
  if (Array.isArray(items.anyOf)) return items.anyOf.map((o) => String(o?.title ?? o?.const ?? "")).filter(Boolean);
  return [];
}
