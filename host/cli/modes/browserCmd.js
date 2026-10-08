// `9remote browser …` — headless commands that drive the running host's local
// API (same pattern as key/devices). Output is agent-friendly: element tables
// and run outcomes print as compact text, everything else as JSON.
import fs from "node:fs";
import { renderTreeLines } from "../../features/browserUse/compress.js";
import { apiPost, isServerRunning } from "../core/localApi.js";

function parseArgs(args) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--url") { opts.url = args[++i]; continue; }
    if (a === "--max-steps") { opts.maxSteps = Number(args[++i]); continue; }
    if (a === "--attach") { throw new Error("--attach is temporarily disabled — own-profile Chrome only"); }
    if (a === "--extension") { throw new Error("--extension is temporarily disabled — own-profile Chrome only"); }
    if (a === "--no-headless") { opts.headless = false; continue; }
    if (a === "--enter") { opts.enter = true; continue; }
    if (a === "--only") { opts.only = args[++i]; continue; }
    if (a === "--parent") { opts.parent = args[++i]; continue; }
    if (a === "--from") { opts.from = Number(args[++i]); continue; }
    if (a === "--len") { opts.len = Number(args[++i]); continue; }
    if (a === "--head") { opts.head = Number(args[++i]); continue; }
    if (a === "--tail") { opts.tail = /^\d+$/.test(args[i + 1] ?? "") ? Number(args[++i]) : true; continue; }
    if (a === "-C") { opts.context = Number(args[++i]); continue; }
    if (a === "-B") { opts.before = Number(args[++i]); continue; }
    if (a === "-A") { opts.after = Number(args[++i]); continue; }
    if (a === "-n") { opts.lineNumbers = true; continue; }
    if (a === "-v") { opts.invert = true; continue; }
    if (a === "-m") { opts.max = Number(args[++i]); continue; }
    if (a === "-q") { opts.quiet = true; continue; }
    if (a === "--links" || a === "-l") { opts.links = true; continue; }
    if (a === "--light") { opts.light = true; continue; }
    if (a === "--nowait") { opts.nowait = true; continue; }
    if (a === "--fields") { opts.fields = parseFieldsArg(args[++i]); continue; }
    if (a === "--expect-text") { (opts.expectText ||= []).push(args[++i]); continue; }
    if (a === "--expect-url") { opts.expectUrl = args[++i]; continue; }
    if (a === "--expect-title") { opts.expectTitle = args[++i]; continue; }
    if (a === "--prompt") { opts.promptText = args[++i]; continue; }
    if (a === "--wait") { opts.wait = args[++i]; continue; }
    if (a === "--no-coords") { opts.noCoords = true; continue; }
    if (a === "--new" || a === "--new-tab") { opts.newTab = true; continue; }
    if (a === "--timeout-ms") { opts.timeoutMs = Number(args[++i]); continue; }
    if (a === "--steps") { opts.stepsJson = args[++i]; continue; } // JSON step array — bypasses the text DSL
    if (a === "--goal") { opts.goal = args[++i]; continue; } // declared destination — anchors the repair shot
    positional.push(a);
  }
  return { positional, opts };
}

// --fields "Label=text;Other=more" -> { Label: "text", Other: "more" }
function parseFieldsArg(raw) {
  const fields = {};
  for (const pair of String(raw || "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq > 0) fields[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
  }
  return Object.keys(fields).length ? fields : undefined;
}

async function call(action, payload) {
  if (!(await isServerRunning())) {
    console.error("9remote server is not running — start it first (9remote ui / start)");
    process.exit(1);
  }
  // Each AI session drives its own engine tab — without this two concurrent
  // agents yank the shared tab mid-operation.
  const tabKey = process.env.NINE_REMOTE_SESSION_ID;
  if (/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(tabKey ?? "")) payload.tabKey = tabKey.toLowerCase();
  const res = await apiPost("/api/browser-use", { action, payload });
  if (!res) { console.error("Local API unreachable"); process.exit(1); }
  return res.json();
}

function mustOk(data) {
  if (!data?.ok) throw new Error(data?.error || "Request failed");
  return data;
}

let activeOpts = {};
function printState(state) {
  console.log(`${state.url}`);
  console.log(`${state.title || ""} · ${state.actions?.length ?? 0} elements · ${state.w}x${state.h}`);
  const real = state.actions?.filter((a) => typeof a.node === "number").length ?? 0;
  if (state.element_from != null && state.total_elements > real) {
    console.log(`[elements ${state.element_from + 1}-${state.element_from + real} of ${state.total_elements}]`);
  }
  if (activeOpts.light) return; // "&" lines in sh mode — action ran, table suppressed
  // Page text rides along (already filtered) — no follow-up read round trip.
  if (!state.element_from) {
    const text = String(state.text || "").replace(/\s+/g, " ").trim();
    if (text) console.log(`text: ${text.slice(0, 800)}${text.length > 800 ? " …" : ""}`);
  }
  // Full structural tree — sections nest by path and repeating rows collapse,
  // so a 400-element page stays readable where a flat 40-row cut misleads.
  console.log(renderTreeLines(state.actions || [], { coords: !activeOpts.noCoords }));
  if (state.omitted_actions) console.log(`… ${state.omitted_actions} more elements cut by the cap`);
}

// Chain script parser: split on top-level ';' (quotes respected), one step each.
export function splitTop(script) {
  const parts = [];
  let cur = "", quote = null;
  for (const ch of script) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === ";") { parts.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter(Boolean);
}

export function parseStep(raw) {
  const match = raw.match(/^(go|click|select|type|enter|scroll|wait|run|read|search|find|hover|upload|shot)\b\s*(.*)$/);
  if (!match) throw new Error(`Cannot parse step: ${raw}`);
  const [, op, rest] = match;
  const argv = rest.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const unq = (v) => String(v).replace(/^["']|["']$/g, "");
  const at = (f) => { const k = argv.indexOf(f); return k >= 0 ? unq(argv[k + 1]) : undefined; };
  const numAt = (f) => { const k = argv.indexOf(f); return k >= 0 ? Number(unq(argv[k + 1])) : undefined; };
  switch (op) {
    case "click":
    case "select":
    case "hover":
      // Second quoted arg = label guard: after a navigation ids are untrusted,
      // the guard makes a wrong id fail BEFORE the click.
      return { op, id: unq(argv[0]), label: argv[1] ? unq(argv[1]) : undefined };
    case "type": {
      const enter = argv.includes("--enter");
      // --label "X": label guard — after a navigation ids are untrusted and a
      // bare id must carry the guard (same contract as click's second quoted arg).
      const labelIdx = argv.indexOf("--label");
      const label = labelIdx >= 0 ? unq(argv[labelIdx + 1]) : undefined;
      const drop = new Set(["--enter"]);
      if (labelIdx >= 0) { drop.add(labelIdx); drop.add(labelIdx + 1); }
      const vals = argv.filter((_, i) => !drop.has(i));
      return { op, id: unq(vals[0]), label, text: unq(vals.slice(1).join(" ")), enter };
    }
    case "go": {
      const first = unq(argv[0]);
      if (!first) throw new Error(`go step needs a url or tab selector: ${raw}`);
      if (first === "tab") return { op, tab: unq(argv[1]) };
      if (/^#?\d+$/.test(first)) return { op, tab: first };
      return { op, url: first, newTab: argv.includes("--new") };
    }
    case "read":
      return { op: "read", parent: at("--parent"), head: numAt("--head"), tail: numAt("--tail"),
        from: numAt("--from"), len: numAt("--len") };
    case "search":
      return {
        op: "search", pattern: unq(argv[0] ?? ""),
        context: numAt("-C"), before: numAt("-B"), after: numAt("-A"),
        lineNumbers: !argv.includes("--no-numbers"),
        invert: argv.includes("-v"), max: numAt("-m"),
        quiet: argv.includes("-q"), links: argv.includes("--links"),
        head: numAt("--head"), tail: numAt("--tail"), parent: at("--parent"),
        for: numAt("--for")
      };
    case "find":
      return { op: "find", pattern: unq(argv.join(" ")) || undefined,
        from: numAt("--from"), tail: numAt("--tail"), parent: at("--parent") };
    case "upload":
      return { op: "upload", label: unq(argv[0]), file: unq(argv[1]) };
    case "shot":
      return { op };
    case "enter":
      return { op };
    case "scroll": {
      const first = unq(argv[0]);
      if (first === "to") return { op, to: unq(argv[1]) };
      if (first === "y") return { op, y: Number(unq(argv[1])) };
      return { op, direction: first || "down" };
    }
    case "wait": {
      const first = argv[0];
      if (first && /^["']/.test(first)) {
        const ms = Number(unq(argv[1]));
        return Number.isFinite(ms) && ms > 0 ? { op, text: unq(first), ms } : { op, text: unq(first) };
      }
      return { op, ms: Number(first) || 300 };
    }
    default: { // run — flags below must NEVER leak into the goal text
      const FLAGS = ["--only", "--parent", "--expect-url", "--expect-text", "--fields", "--max-steps", "--prompt"];
      const drop = new Set();
      for (let k = 0; k < argv.length; k++) {
        if (FLAGS.includes(argv[k])) { drop.add(k); if (k + 1 < argv.length) drop.add(k + 1); }
      }
      const goal = unq(argv.filter((_, i) => !drop.has(i)).join(" "));
      if (!goal) throw new Error(`run step needs a goal (flags alone are not one): ${raw}`);
      const expectTextIdx = argv.indexOf("--expect-text");
      const expectText = expectTextIdx >= 0 ? [unq(argv[expectTextIdx + 1])] : undefined;
      return {
        op: "run", goal,
        only: at("--only"),
        parent: at("--parent"),
        fields: at("--fields") ? parseFieldsArg(at("--fields")) : undefined,
        maxSteps: at("--max-steps") ? Number(at("--max-steps")) : undefined,
        expectUrl: at("--expect-url"),
        expectText
      };
    }
  }
}

function printRun(result) {
  for (const s of result.steps || []) {
    const bits = [`#${s.seq}`, s.operation, s.targetIndex ? `[${s.targetIndex}]` : "", s.label || ""]
      .filter(Boolean).join(" ");
    console.log(`  ${bits} · ${s.result}`);
  }
  console.log(`outcome: ${result.outcome}${result.reason ? ` — ${result.reason}` : ""}`);
  console.log(`metrics: ${result.metrics?.steps ?? 0} steps · ${result.metrics?.modelCalls ?? 0} jev calls · ${Math.round((result.metrics?.elapsedMs ?? 0) / 100) / 10}s`);
  console.log(`url: ${result.url || ""}`);
  printConsole(result.console);
  if (result.outcome === "needs_verification") console.log("element table below — verify before claiming success (shot for visual).");
}

function printConsole(lines) {
  if (!lines?.length) return;
  console.log("console (tail):");
  for (const l of lines) console.log(`  ${l.level.padEnd(7)} ${l.text}`);
}

const HELP = `9remote browser — one-shot journeys: chain | batch | run

  EVERY browser task is ONE call. Never poke one verb at a time.

  1) chain — the one interface (14 ops). ALWAYS --goal, ALWAYS to the end of the task:
  9remote browser chain --goal "weekly trending report" --steps '[
    {"op":"go","url":"https://github.com/trending?since=weekly"},
    {"op":"run","goal":"dismiss any cookie banner","expectText":["Trending"]},
    {"op":"click","label":"Skip","when":{"text":"Skip tutorial"}},
    {"op":"search","pattern":"stars this week","context":2},
    {"op":"find","pattern":"Load more"},
    {"op":"shot"}
  ]'
  Ops: go(tab/url/newTab) scroll(to/y/down/up) click(label/id/tryLabels/prompt/nav)
       type(label,text,enter) select(option) hover enter upload(label,file)
       read(parent,head,tail,from,len) search(pattern,context,links,for) find(pattern,from,tail) shot
       run(goal,fields,expectText,steps)
  Every op takes when:{text|textNot|url} (skip-if-unmet, composes into if/else).
  Unknown labels are not a reason to stop — a run step carries the journey
  through them. The engine settles adaptively between steps — never declare
  waits; only search takes for:<ms> when evidence is KNOWN to arrive late.

  2) batch — same ops as one-per-line text (heredoc, no JSON quoting):
  9remote browser batch <<'EOF'
  go https://github.com/trending
  search "stars this week" -C 2
  EOF

  3) run — hand a whole unknown-label segment to Jev (the fast model
     decides on the live table, you keep the text):
     9remote browser run "log in" --fields "Email=me@x.co;Password=s3cret" --expect-text "Dashboard"

  WHEN A CHAIN BREAKS: the response names the failing step, returns the live
  state/console AND \`pending\` (the steps not yet run). Issue ONE new chain
  with the pending steps adjusted — never fall back to single verbs.`;

// Agent surface: journeys only. Standalone verbs taught models to poke-then-
// look (one shot per poke), so the CLI refuses them before any network call;
// `batch` lines and humans reach the full dispatch via {fromBatch}.
const AGENT_SUBS = new Set(["chain", "batch", "sh", "run", "help", "--help", "-h", undefined]);
export function agentBlockedSub(sub, { fromBatch = false } = {}) {
  if (fromBatch || AGENT_SUBS.has(sub)) return null;
  const hint = { cat: "read", grep: "search", text: "search", elements: "find", ls: "find", jev: "run", delegate: "run" }[sub] || sub;
  return new Error(`single "${sub}" is agent-disabled — pack it into a chain: ` +
    `9remote browser chain --steps '[{"op":"${hint}","label":"…"}]' ` +
    `(or: 9remote browser batch < script)`);
}

const requiredArg = (rest, name) => {
  if (!rest[0]) throw new Error(`Missing ${name}`);
  return rest[0];
};

export async function cmdBrowser(args, { fromBatch = false } = {}) {
  const { positional, opts } = parseArgs(args);
  activeOpts = opts;
  const [sub, ...restRaw] = positional;
  // sh/DSL tokens keep their quotes — strip a matched pair once, right here.
  const unq = (v) => String(v).replace(/^["']|["']$/g, "");
  const rest = restRaw.map(unq);
  const isAttach = opts.mode === "attach";
  if (opts.mode === "extension") opts.profile = "__extension__"; // engine keys the shared bridge session
  const payload = (extra = {}) => ({
    profile: isAttach ? "__attach__" : undefined, // engine defaults the own-mode profile
    ...opts,
    ...extra
  });
  try {
  const blocked = agentBlockedSub(sub, { fromBatch });
  if (blocked) throw blocked;
  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    case "tabs": {
      const data = mustOk(await call("tabs", payload()));
      for (const t of data.tabs || []) {
        const marker = t.active ? "* " : "  ";
        const idxStr = t.index ? `#${t.index} ` : "";
        console.log(`${marker}${idxStr}[${t.id}] ${t.title || "(untitled)"} — ${t.url}`);
      }
      return;
    }
    case "go": {
      // go <url> | go tab <sel> | go #n — navigation and tab switching in one verb
      const first = rest[0];
      const isTabSel = first === "tab" || /^#?\d+$/.test(first || "");
      const body = isTabSel
        ? { tab: first === "tab" ? rest[1] : first }
        : { url: requiredArg(rest, "url"), newTab: Boolean(opts.newTab) };
      const data = mustOk(await call("go", payload({ ...body, wait: opts.wait, timeoutMs: opts.timeoutMs })));
      const modeLabel = isAttach ? "real browser (debug)" : opts.mode === "extension" ? "real browser (extension)" : "isolated Chrome";
      console.log(isTabSel ? `switched: #${data.index || ""} ${data.title || ""} — ${data.url || ""}` : `went to ${rest[0]} (${modeLabel})`);
      if (data.state) printState(data.state);
      return;
    }
    case "ls": {
      const data = mustOk(await call("ls", payload()));
      printState(data);
      return;
    }
    case "undbg": {
      const data = mustOk(await call("undbg", { ...payload(), ms: Number(opts.ms) || undefined }));
      console.log(`debugger detached ${data.ms}ms — state re-served after re-attach`);
      if (opts.state !== false && data.state) printState(data.state); // mid-nav: stateAfter may be null
      break;
    }
    case "clear": {
      const data = mustOk(await call("clear", payload()));
      console.log(`cleared site data: ${data.cleared}`);
      break;
    }
    case "console": {
      const data = mustOk(await call("console", payload()));
      const lines = data.lines || [];
      if (!lines.length) console.log("(console empty)");
      for (const l of lines) console.log(`${l.level.padEnd(7)} ${l.text}`);
      return;
    }
    case "read": {
      // Markdown-lite page read — --parent scopes to a tree section, --head/--tail
      // cut the rendered lines, --from/--len window past the cap.
      const data = mustOk(await call("read", payload()));
      const text = data.text || "";
      const from = data.from || 0;
      if (from > 0 || (data.total || 0) > from + text.length) {
        console.log(`[chunk ${from}-${from + text.length} of ${data.total ?? "?"} chars]`);
      }
      console.log(text);
      if (!text.trim()) console.log("(no readable text — wrong section name? ls shows sections in the tree)");
      return;
    }
    case "search": {
      // search/grep over page content; exit code 1 on zero hits (unless -q).
      const data = mustOk(await call("search", payload({ pattern: rest.join(" ") })));
      if (data.text) console.log(data.text);
      console.log(`(${data.matched ?? 0} matches)`);
      if (!data.quiet && !(data.matched > 0)) process.exitCode = 1;
      return;
    }
    case "find": {
      // find(1) over the element table: id, label, role or href.
      const data = mustOk(await call("find", payload({ pattern: rest.join(" ") })));
      console.log(`${data.matched ?? 0}/${data.total ?? "?"} elements:`);
      console.log(renderTreeLines(data.actions || [], { coords: true }));
      return;
    }
    case "sh": // hidden alias — the taught name is `batch`
    case "batch": {
      // Batch mode (mysql < script.sql): one spawn, N commands on the shared
      // session. Lines run sequentially like ";" — a failure prints and the
      // next line still runs. Trailing "&" suppresses the returned table.
      let script = "";
      try { script = fs.readFileSync(0, "utf8"); }
      catch { console.error("batch reads commands from stdin: 9remote browser batch < script.txt"); process.exitCode = 1; return; }
      const lines = script.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      for (const line of lines) {
        const light = /\s*&\s*$/.test(line);
        const clean = line.replace(/\s*&\s*$/, "");
        const args = clean.match(/"[^"]*"|'[^']*'|\S+/g) || [];
        if (light) args.push("--light");
        console.log(`\n$ ${clean}`);
        try { await cmdBrowser(args, { fromBatch: true }); }
        catch (e) { console.error(`  ✗ ${e.message}`); }
      }
      return;
    }
    case "run": {
      const data = mustOk(await call("run", payload({ goal: rest.join(" ") })));
      printRun(data);
      if (data.verification) {
        console.log(`verification: ${data.verification.passed ? "PASSED — independently verified, safe to report success" : "FAILED"}`);
        for (const [check, ok] of Object.entries(data.verification.checks)) {
          if (!ok) console.log(`  not met: ${check}`);
        }
      }
      if (data.frame) console.log(`frame: ${data.frame}`);
      if (data.state) printState(data.state);
      return;
    }
    case "click": {
      const data = mustOk(await call("click", payload({ id: rest[0], wait: opts.wait, timeoutMs: opts.timeoutMs })));
      console.log(`clicked ${rest[0]}`);
      if (data.state) printState(data.state);
      return;
    }
    case "clickxy": {
      const data = mustOk(await call("clickxy", payload({ x: Number(rest[0]), y: Number(rest[1]) })));
      console.log(`clicked x=${rest[0]} y=${rest[1]}`);
      if (data.state) printState(data.state);
      return;
    }
    case "scroll": {
      const where = String(rest[0] || "").toLowerCase();
      let body;
      if (["top", "bottom"].includes(where)) body = { edge: where };
      else if (["down", "up"].includes(where)) body = { direction: where };
      else if (where === "to") body = { to: String(rest[1] || "") };
      else if (where === "y") body = { y: Number(rest[1]) };
      else body = { px: Number(where) || undefined, direction: "down" };
      const data = mustOk(await call("scroll", payload(body)));
      if (data.state) printState(data.state);
      return;
    }
    case "back":
    case "forward": {
      const data = mustOk(await call(sub, payload()));
      if (data.state) printState(data.state);
      return;
    }
    case "reload": {
      const data = mustOk(await call("reload", payload()));
      if (data.state) printState(data.state);
      return;
    }
    case "key": {
      const data = mustOk(await call("key", payload({ name: rest[0] })));
      if (data.state) printState(data.state);
      return;
    }
    case "hover": {
      const data = mustOk(await call("hover", payload({ id: rest[0] })));
      console.log(`hovered ${rest[0]}`);
      if (data.state) printState(data.state);
      return;
    }
    case "wait": {
      // Trailing bare number = timeout budget: wait "Row 5" 1500
      const tailNum = /^\d+$/.test(restRaw.at(-1) ?? "") ? Number(restRaw.at(-1)) : null;
      const textParts = tailNum != null ? rest.slice(0, -1) : rest;
      const text = textParts.join(" ");
      const data = mustOk(await call("wait", payload({ text, timeoutMs: tailNum ?? undefined })));
      console.log(`wait "${text}": ${data.found ? "FOUND" : "TIMEOUT"}`);
      if (data.state) printState(data.state);
      return;
    }
    case "tabclose": {
      const target = rest[0] ?? null;
      const data = mustOk(await call("tabclose", payload(target != null ? { target } : {})));
      console.log(`closed: ${data.closed}`);
      return;
    }
    case "type": {
      const data = mustOk(await call("type", payload({ id: rest[0], text: rest.slice(1).join(" "), enter: Boolean(opts.enter), wait: opts.wait, timeoutMs: opts.timeoutMs })));
      console.log(`typed into ${rest[0]}${opts.enter ? " + enter" : ""}`);
      if (data.state) printState(data.state);
      return;
    }
    case "upload": {
      const data = mustOk(await call("upload", payload({ id: rest[0], file: rest[1] })));
      console.log(`uploaded ${data.uploaded} into ${rest[0]}`);
      if (data.state) printState(data.state);
      return;
    }
    case "download": {
      const data = mustOk(await call("download", payload({ timeout: opts.timeout })));
      console.log(`downloaded: ${data.download.path}`);
      return;
    }
    case "drag": {
      const data = mustOk(await call("drag", payload({ from: rest[0], to: rest[1] })));
      console.log(`dragged ${rest[0]} onto ${rest[1]}`);
      return;
    }
    case "enter": {
      const data = mustOk(await call("enter", payload()));
      console.log("enter pressed");
      if (data.state) printState(data.state);
      return;
    }
    case "shot": {
      const data = mustOk(await call("shot", payload()));
      // Write a jpeg and print the path — agents Read the file instead of
      // burning tokens on a base64 blob in terminal output.
      const file = `/tmp/9remote-shot-${Date.now()}.jpg`;
      fs.writeFileSync(file, Buffer.from(data.image, "base64"));
      console.log(file);
      return;
    }
    case "chain": {
      // --steps '<JSON array>' is the canonical form (zero parse ambiguity, run.steps
      // nesting supported); the text DSL stays for quick one-liners.
      let steps;
      if (opts.stepsJson) {
        // THROW, never exit: an sh batch catches per line and keeps going.
        try { steps = JSON.parse(opts.stepsJson); }
        catch { throw new Error("--steps is not valid JSON"); }
        if (!Array.isArray(steps) || !steps.length) throw new Error("--steps needs a non-empty JSON array");
      } else {
        steps = splitTop(rest.join(" ")).map(parseStep);
      }
      // NOT mustOk: a failed chain still carries results/failedStep/state that
      // must reach the agent — "Request failed" alone hides where it broke.
      const data = await call("chain", payload({ steps }));
      if (!data?.results) { mustOk(data); return; }
      for (const r of data.results) {
        console.log(`  ${r.ok ? (r.skipped ? "skip" : "ok") : "FAIL"} #${r.step} ${r.summary || r.op}${r.error ? ` — ${r.error}` : ""}`);
        if (["read", "search", "find"].includes(r.op) && r.text) {
          for (const line of r.text.split("\n")) console.log(`      ${line}`);
        }
      }
      if (data.failedStep) {
        console.error(`chain stopped at step ${data.failedStep}`);
        // The break state is data, not a crash — but a failing exit code lets
        // callers (and their harnesses) tell success from repair-needed.
        process.exitCode = 1;
      }
      if (data.goal) console.error(`goal "${data.goal}" — reached ${data.progress}`);
      if (data.pending?.length) console.log(`pending: ${JSON.stringify(data.pending)}`);
      if (data.note) console.log(data.note);
      printConsole(data.console);
      // Full element table only when the agent needs to repair (chain broke, or
      // no step returned text) — a clean read chain ends with one line instead
      // of a ~30KB table that pushes output past the 32KB persisted-file cap.
      const hasText = data.results?.some((r) => r.text?.trim());
      if (data.state && (data.failedStep || !hasText)) printState(data.state);
      else if (data.state) console.log(`${data.state.url} · ${data.state.title || ""} · ${data.state.actions?.length ?? 0} elements`);
      return;
    }
    case "close":
      mustOk(await call("close", payload()));
      console.log("closed");
      return;
    case "attach":
      // Parked mode — see ALLOWED_MODES in features/browserUse/constants.js.
      throw new Error("attach is temporarily disabled — own-profile Chrome only");
    case "status": {
      const data = mustOk(await call("status", {}));
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    default:
      // THROW, never exit: an sh batch catches per line and keeps going.
      throw new Error(`Unknown browser subcommand: ${sub}\n${HELP}`);
  }
  } catch (e) {
    // mustOk throws so `sh` batches can catch per line and keep going; a
    // standalone invocation still reports and sets a failing exit code.
    console.error(e.message);
    process.exitCode = 1;
  }
}
