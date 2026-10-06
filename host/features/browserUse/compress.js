// Observation-compression experiments for the Jev choice protocol. Pure helpers
// only: each renderer serializes one observed page state into a candidate
// prompt format. The benchmark (host/test/browserUseCompress.test.mjs) ranks
// them; nothing here is wired into the live loop yet.
// Every renderer MUST preserve the choice invariants: all element ids appear
// exactly once and id -> label stays injective (the live loop guarantees the
// same via its "(2)" ordinal suffixes).

const MIN_PREFIX = 4; // below this a label carries too little meaning to cut

// Shortest prefix of each label that no other label shares. Identical strings
// get an ordinal suffix; a label that is a proper prefix of another stays full.
export function minUniquePrefixes(labels) {
  const out = new Array(labels.length);
  const byString = new Map();
  labels.forEach((label, i) => {
    if (!byString.has(label)) byString.set(label, []);
    byString.get(label).push(i);
  });
  const unique = [...byString.keys()];
  for (const [label, indexes] of byString) {
    let base = label;
    for (let cut = MIN_PREFIX; cut < label.length; cut++) {
      const prefix = label.slice(0, cut);
      // A prefix ending in whitespace reads as truncated — cut past it instead
      if (/\s$/.test(prefix)) continue;
      if (!unique.some((other) => other !== label && other.startsWith(prefix))) { base = prefix; break; }
    }
    indexes.forEach((idx, n) => { out[idx] = n === 0 ? base : `${base} (${n + 1})`; });
  }
  return out;
}

// Final global pass every renderer applies: exact duplicates get ordinals so
// id -> label is injective (same contract as the live buildActionSpace). The
// suffix must itself be unused — inputs may already carry "(2)" suffixes.
export function dedupeOrdinals(labels) {
  const used = new Set();
  return labels.map((label) => {
    if (!used.has(label)) { used.add(label); return label; }
    let n = 2;
    while (used.has(`${label} (${n})`)) n++;
    const out = `${label} (${n})`;
    used.add(out);
    return out;
  });
}

// Group items by an arbitrary key, sections ordered by first appearance.
export function groupByPath(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item) || "Page";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups].map(([path, items]) => ({ path, items }));
}

const sigOf = (el) => `${el.role}|${el.kind}`;

// Maximal runs of CONSECUTIVE items sharing a signature.
export function collapseRuns(items) {
  const runs = [];
  for (const item of items) {
    const last = runs[runs.length - 1];
    if (last && last.sig === sigOf(item)) last.items.push(item);
    else runs.push({ sig: sigOf(item), items: [item] });
  }
  return runs;
}

// Repeating-CYCLE detection (tables, grids, lists): if the items are exactly
// k repetitions of the same signature period, the constant slots (same label
// every cycle) collapse into the header and only the varying labels remain.
// Interleaved layouts (link, Edit, Delete, link, …) are invisible to
// collapseRuns but collapse hard here. Needs an exact whole-list period.
export function findCycle(items, maxPeriod = 50) {
  const n = items.length;
  for (let period = 1; period <= Math.min(maxPeriod, n / 3); period++) {
    if (n % period !== 0) continue;
    const cycles = n / period;
    if (cycles < 3) continue;
    const ok = items.every((el, i) => sigOf(el) === sigOf(items[i % period]));
    if (!ok) continue;
    const constant = [];
    for (let j = 0; j < period; j++) {
      const label = items[j].label;
      constant.push(items.filter((_, idx) => idx % period === j).every((el) => el.label === label));
    }
    return { period, cycles, constant };
  }
  return null;
}

const esc = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const cleanLabel = (s, max = 80) => {
  const c = esc(s);
  return c.length > max ? c.slice(0, max - 1) + "…" : c;
};
const lineOf = (el, label, coords = false) => {
  const value = el.value ? ` =${esc(el.value).slice(0, 30)}` : "";
  const state = el.checked ? ` [${el.checked}]` : "";
  const href = el.href ? ` -> ${cleanLabel(el.href, 70)}` : "";
  const pt = coords && el.rect
    ? ` [${Math.round(el.rect.x + (el.rect.w ? el.rect.w / 2 : 0))},${Math.round(el.rect.y + (el.rect.h ? el.rect.h / 2 : 0))}]` : "";
  // Synthetic controls (scroll/wait) have no role — their kind is the role
  return `${el.id} ${el.role || el.kind} "${cleanLabel(label)}"${state}${value}${href}${pt}`;
};

// Page gist shared by every renderer so the benchmark only measures element
// encoding, not page-text differences.
function gist(state) {
  const head = `PAGE ${esc(state.url)} | ${esc(state.title)}`;
  const headings = state.headings?.length ? `\nH: ${state.headings.map(esc).join(" · ")}` : "";
  const scroll = state.scroll ? `\nSCROLL ${state.scroll.y}/${state.scroll.height}` : "";
  const text = state.text ? `\nTEXT ${esc(state.text)}` : "";
  return head + headings + scroll + text + "\n";
}

function finalize(elements, labels) {
  const fixed = dedupeOrdinals(labels);
  return { labels: new Map(elements.map((el, i) => [el.id, fixed[i]])), fixed };
}

// ---- renderers: {body, labels} from the same elements array ----------------

export function renderFlat(state) {
  const { labels, fixed } = finalize(state.elements, state.elements.map((el) => el.label));
  const body = gist(state) + state.elements.map((el, i) => lineOf(el, fixed[i])).join("\n");
  return { body, labels };
}

export function renderFlatMinPrefix(state) {
  const { labels, fixed } = finalize(state.elements,
    minUniquePrefixes(state.elements.map((el) => el.label)));
  const body = gist(state) + state.elements.map((el, i) => lineOf(el, fixed[i])).join("\n");
  return { body, labels };
}

export function renderFlatGrouped(state) {
  const { labels, fixed } = finalize(state.elements, state.elements.map((el) => el.label));
  const sections = groupByPath(state.elements, (el) => el.path?.join(" > "));
  const byId = new Map(state.elements.map((el, i) => [el.id, fixed[i]]));
  const body = gist(state) + sections.map(({ path, items }) =>
    `[${path}]\n` + items.map((el) => `  ${lineOf(el, byId.get(el.id))}`).join("\n")).join("\n");
  return { body, labels };
}

// Shared cycle block: header carries constant slots, per-cycle lines carry the
// varying labels. Uniform lists (period 1, one label) become a dense one-liner.
function cycleBlock(items, cycle, byId) {
  const { period, cycles: count, constant } = cycle;
  if (period === 1 && constant[0]) {
    return [`${items[0].role} "${cleanLabel(items[0].label)}" ×${count}: ` +
      items.map((el) => el.id).join(" ")];
  }
  const slots = Array.from({ length: period }, (_, j) =>
    constant[j] ? `${items[j].role} "${cleanLabel(items[j].label)}"` : items[j].role);
  const rows = [];
  for (let c = 0; c < count; c++) {
    rows.push(Array.from({ length: period }, (_, j) => {
      const el = items[c * period + j];
      return constant[j] ? el.id : `${el.id} ${cleanLabel(byId.get(el.id))}`;
    }).join(" · "));
  }
  return [`row ×${count} [${slots.join(", ")}]`, ...rows];
}

// Cycle-aware encoding of one item list: cycles collapse to header + per-cycle
// lines (constant slots are bare ids, varying slots keep their label); plain
// runs collapse densely when labels match; anything else stays one line each.
function encodeItems(items, byId) {
  const cycle = findCycle(items);
  if (cycle) return cycleBlock(items, cycle, byId);
  return collapseRuns(items).flatMap((run) => {
    const same = new Set(run.items.map((el) => el.label));
    if (same.size === 1 && run.items.length > 1) {
      return [`${run.items[0].role} "${cleanLabel(run.items[0].label)}" ×${run.items.length}: ` +
        run.items.map((el) => el.id).join(" ")];
    }
    return run.items.map((el) => lineOf(el, byId.get(el.id)));
  });
}

// How many full signature cycles repeat at items[start..] for this period.
function maxCycles(items, start, period) {
  let cycles = 0;
  while (start + (cycles + 1) * period <= items.length &&
    items.slice(start + cycles * period, start + (cycles + 1) * period)
      .every((el, k) => sigOf(el) === sigOf(items[start + k]))) cycles++;
  return cycles;
}

// Cycle-collapse for one section's items. The best (start, period) is scanned
// across ALL starts, scored by constant-slot DENSITY (count/period — a doubled
// period would otherwise double its count without adding information), then by
// covered length, then smallest period. A cycle that absorbed leading noise as
// a pseudo-row scores fewer repeating slots than one aligned at the true row
// boundary, so the scan self-corrects the alignment.
// Guards: period 1 only for uniform labels (dense list); a uniform-signature
// cycle (all-link HN rows) must repeat at least one label — a run of unique
// labels like a nav bar has no constant slot and never forms a pseudo-cycle.
function encodeSection(items, byId, coords = false) {
  let best = null; // {start, len, cycle, density}
  const better = (density, len, period) =>
    !best || density > best.density + 1e-9 ||
    (Math.abs(density - best.density) < 1e-9 && (len > best.len ||
      (len === best.len && period < best.cycle.period)));
  for (let start = 0; start + 6 <= items.length; start++) {
    const maxPeriod = Math.min(50, Math.floor((items.length - start) / 3));
    for (let period = 1; period <= maxPeriod; period++) {
      const cycles = maxCycles(items, start, period);
      if (cycles < 3) continue;
      if (period === 1 && new Set(items.slice(start, start + cycles).map((el) => el.label)).size > 1) continue;
      const constant = Array.from({ length: period }, (_, j) => {
        const label = items[start + j].label;
        for (let c = 1; c < cycles; c++) if (items[start + c * period + j].label !== label) return false;
        return true;
      });
      const constCount = constant.filter(Boolean).length;
      if (constCount === 0 && new Set(items.slice(start, start + period).map(sigOf)).size < 2) continue;
      const len = cycles * period;
      if (better(constCount / period, len, period)) {
        best = { start, len, cycle: { period, cycles, constant }, density: constCount / period };
      }
    }
  }
  if (!best) return items.map((el) => lineOf(el, byId.get(el.id), coords));
  const before = items.slice(0, best.start).map((el) => lineOf(el, byId.get(el.id), coords));
  const block = cycleBlock(items.slice(best.start, best.start + best.len), best.cycle, byId);
  const rest = encodeSection(items.slice(best.start + best.len), byId, coords);
  return [...before, ...block, ...rest];
}

export function renderFlatCollapsed(state) {
  const { labels, fixed } = finalize(state.elements, state.elements.map((el) => el.label));
  const byId = new Map(state.elements.map((el, i) => [el.id, fixed[i]]));
  return { body: gist(state) + encodeItems(state.elements, byId).join("\n"), labels };
}

export function renderFlatAll(state) {
  const sections = groupByPath(state.elements, (el) => el.path?.join(" > "));
  const base = [];
  for (const { items } of sections) {
    const cut = minUniquePrefixes(items.map((el) => el.label));
    items.forEach((el, i) => base.push(cut[i]));
  }
  const { labels, fixed } = finalize(state.elements, base);
  const byId = new Map(state.elements.map((el, i) => [el.id, fixed[i]]));
  const parts = [];
  for (const { path, items } of sections) parts.push(`[${path}]\n` + encodeItems(items, byId).join("\n"));
  return { body: gist(state) + parts.join("\n"), labels };
}

const indent = (depth) => "  ".repeat(depth);

// Tree lines nested by path segments — the ariaSnapshot/orca shape. Pure walk
// with no page gist: the live loop embeds these lines into its own state.page.
export function renderTreeLines(elements, { coords = false } = {}) {
  const fixed = dedupeOrdinals(elements.map((el) => el.label));
  const byId = new Map(elements.map((el, i) => [el.id, fixed[i]]));
  const lines = [];
  const walk = (items, depth) => {
    for (const { path: seg, items: group } of groupByPath(items, (el) => el.path?.[0])) {
      lines.push(`${indent(depth)}${seg}:`);
      const deeper = group.filter((el) => (el.path?.length ?? 1) > 1)
        .map((el) => ({ ...el, path: el.path.slice(1) }));
      const here = group.filter((el) => (el.path?.length ?? 1) <= 1);
      // Leaves collapse repeating row cycles (tables/grids); lone items stay plain
      for (const line of encodeSection(here, byId, coords)) lines.push(`${indent(depth + 1)}${line}`);
      if (deeper.length) walk(deeper, depth + 1);
    }
  };
  walk(elements, 0);
  return lines.join("\n");
}

// Tree renderers nest by path segments — the ariaSnapshot/orca shape.
export function renderTreeYaml(state) {
  const { labels } = finalize(state.elements, state.elements.map((el) => el.label));
  return { body: gist(state) + renderTreeLines(state.elements), labels };
}

// Interactive-only tree: keep ancestor path lines, drop text-only branches.
export function renderTreeInteractive(state) {
  const full = renderTreeYaml(state);
  const kept = full.body.split("\n").filter((line) => /^(PAGE|H:|SCROLL|TEXT)/.test(line) ||
    / e\d+ /.test(line) || /:\s*$/.test(line));
  return { body: kept.join("\n"), labels: full.labels };
}

export const RENDERERS = {
  "flat-baseline": renderFlat,
  "flat-min-prefix": renderFlatMinPrefix,
  "flat-grouped": renderFlatGrouped,
  "flat-collapsed": renderFlatCollapsed,
  "flat-all": renderFlatAll,
  "tree-yaml": renderTreeYaml,
  "tree-interactive": renderTreeInteractive
};
