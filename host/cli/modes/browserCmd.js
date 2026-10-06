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
    if (a === "--attach") { opts.mode = "attach"; continue; }
    if (a === "--extension") { opts.mode = "extension"; continue; }
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
  const match = raw.match(/^(go|click|select|type|enter|scroll|wait|run|cat|grep|find|hover)\b\s*(.*)$/);
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
    case "cat":
      return { op, parent: at("--parent"), head: numAt("--head"), tail: numAt("--tail") };
    case "grep":
      return {
        op, pattern: unq(argv[0] ?? ""),
        context: numAt("-C"), before: numAt("-B"), after: numAt("-A"),
        lineNumbers: !argv.includes("--no-numbers"),
        invert: argv.includes("-v"), max: numAt("-m"),
        quiet: argv.includes("-q"), links: argv.includes("--links"),
        head: numAt("--head"), tail: numAt("--tail"), parent: at("--parent")
      };
    case "find":
      return { op, pattern: unq(argv.join(" ")) };
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
      return first && /^["']/.test(first) ? { op, text: unq(first) } : { op, ms: Number(first) || 300 };
    }
    default: { // run — flags below must NEVER leak into (or eat) the goal text
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

const HELP = `9remote browser — agent-driven Chrome via the host engine (terminal vocabulary)

  # ---- navigate ----
  9remote browser go <url> [--new] [--wait "text"]   # navigate AND print the table (reuses a tab already on the url)
  9remote browser go tab <#n|id|title|url>           # switch tab instead of navigating
  9remote browser ls [--from N] [--tail [N]] [--parent SECTION]  # element table windowed like less
  9remote browser tabs [--attach]                    # list open tabs (* = active, #n = index)

  # ---- read / search (content) ----
  9remote browser grep "<pattern>" [-C N] [-B N] [-A N] [-n] [-v] [-m N] [-q] [--links] [--parent S]
                                             # grep(1) over page text; --links lists [label] -> url
                                             # -q: zero hits is a check result, not exit 1
  9remote browser cat [--parent SECTION] [--head N] [--tail N] [--from N --len N]
                                             # full markdown-lite page read
  9remote browser find "<needle>"           # find(1) over the element table (id/label/role/href)
  9remote browser console                   # page console ring (JS errors when nothing works)

  # ---- act ----
  9remote browser run "<sub-goal>" [--url URL] [--max-steps N] [--only REGEX] [--parent SECTION] [--fields "L=text;..."] [--prompt "text"]
                                             # --only: Jev sees only matching element labels
                                             # --parent: Jev sees only the named tree section
                                             # --fields: Jev picks the fields, engine types YOUR text
                                             # --expect-text "..." / --expect-url / --expect-title:
                                             #   verified on a fresh read — only PASSED is success
  9remote browser click <id> [--wait "text"] [--prompt "text"]   # --prompt answers a window.prompt()
  9remote browser clickxy <x> <y>           click exact page coordinates (custom widgets)
  9remote browser type <id> "<text>" [--enter]
  9remote browser select <id> "<option>"
  9remote browser hover <id>                move the mouse onto an element (hover menus)
  9remote browser key <enter|escape|tab|arrow...>
  9remote browser scroll <top|bottom|down|up|to X|y N|px>
  9remote browser enter | back | forward | reload
  9remote browser wait "<text>"             bounded wait until text/element appears
  9remote browser upload <id> <file-path>   set a file on an observed file input
  9remote browser download [--timeout MS]   wait for the next completed download
  9remote browser drag <from> <to>          HTML5 drag: press at <from>, release over <to>
  9remote browser tabclose [<#n|id|title>]  close the active tab (or by selector)

  # ---- batch (ONE spawn, N commands; a failing line does not stop the rest) ----
  9remote browser sh < script.txt           # each line = one command; trailing "&" suppresses its table
  9remote browser chain "go /login; grep 'Sign in'; click btn1 'Continue'; run 'submit' --expect-url /ok"
                                             # many steps, ONE call, fail-fast at the first wrong step
  9remote browser chain --steps '<JSON>'    # canonical form: [{"op":"go","url":...},{"op":"grep","pattern":...},
                                             # {"op":"click","label":"Buy","when":{"text":"In stock"}}, ...]
                                             # when-guards skip steps whose precondition is unmet (if/else)

  9remote browser shot                      writes /tmp/9remote-shot-*.jpg, prints the path
  9remote browser close | attach | status`;

const requiredArg = (rest, name) => {
  if (!rest[0]) throw new Error(`Missing ${name}`);
  return rest[0];
};

export async function cmdBrowser(args) {
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
  switch (sub) {
    case undefined:
    case "help":
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
      if (opts.state !== false) printState(data.state);
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
    case "cat": {
      // Markdown-lite page read — --parent scopes to a tree section, --head/--tail
      // cut the rendered lines, --from/--len window past the cap.
      const data = mustOk(await call("cat", payload()));
      const text = data.text || "";
      const from = data.from || 0;
      if (from > 0 || (data.total || 0) > from + text.length) {
        console.log(`[chunk ${from}-${from + text.length} of ${data.total ?? "?"} chars]`);
      }
      console.log(text);
      if (!text.trim()) console.log("(no readable text — wrong section name? ls shows sections in the tree)");
      return;
    }
    case "grep": {
      // grep(1) over page content; exit code 1 on zero hits (unless -q).
      const data = mustOk(await call("grep", payload({ pattern: rest.join(" ") })));
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
    case "sh": {
      // Batch mode (mysql < script.sql): one spawn, N commands on the shared
      // session. Lines run sequentially like ";" — a failure prints and the
      // next line still runs. Trailing "&" suppresses the returned table.
      let script = "";
      try { script = fs.readFileSync(0, "utf8"); }
      catch { console.error("sh reads commands from stdin: 9remote browser sh < script.txt"); process.exitCode = 1; return; }
      const lines = script.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      for (const line of lines) {
        const light = /\s*&\s*$/.test(line);
        const clean = line.replace(/\s*&\s*$/, "");
        const args = clean.match(/"[^"]*"|'[^']*'|\S+/g) || [];
        if (light) args.push("--light");
        console.log(`\n$ ${clean}`);
        try { await cmdBrowser(args); }
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
        try { steps = JSON.parse(opts.stepsJson); }
        catch { console.error("--steps is not valid JSON"); process.exit(1); }
        if (!Array.isArray(steps) || !steps.length) { console.error("--steps needs a non-empty JSON array"); process.exit(1); }
      } else {
        steps = splitTop(rest.join(" ")).map(parseStep);
      }
      // NOT mustOk: a failed chain still carries results/failedStep/state that
      // must reach the agent — "Request failed" alone hides where it broke.
      const data = await call("chain", payload({ steps }));
      if (!data?.results) { mustOk(data); return; }
      for (const r of data.results) {
        console.log(`  ${r.ok ? (r.skipped ? "skip" : "ok") : "FAIL"} #${r.step} ${r.summary || r.op}${r.error ? ` — ${r.error}` : ""}`);
        if ((r.op === "cat" || r.op === "grep" || r.op === "find") && r.text) {
          for (const line of r.text.split("\n").slice(0, 5)) console.log(`      ${line}`);
          if (r.text.split("\n").length > 5) console.log("      …");
        }
      }
      if (data.failedStep) console.error(`chain stopped at step ${data.failedStep}`);
      printConsole(data.console);
      if (data.state) printState(data.state);
      return;
    }
    case "close":
      mustOk(await call("close", payload()));
      console.log("closed");
      return;
    case "attach": {
      const data = mustOk(await call("attach.status", {}));
      if (data.available) console.log(`attached (port ${data.port})`);
      else { console.log("not attached:"); (data.guide || []).forEach((s, i) => console.log(`  ${i + 1}. ${s}`)); }
      return;
    }
    case "status": {
      const data = mustOk(await call("status", {}));
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    default:
      console.error(`Unknown browser subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
  } catch (e) {
    // mustOk throws so `sh` batches can catch per line and keep going; a
    // standalone invocation still reports and sets a failing exit code.
    console.error(e.message);
    process.exitCode = 1;
  }
}
