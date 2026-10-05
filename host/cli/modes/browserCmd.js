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
    if (a === "--grep") { opts.grep = args[++i]; continue; }
    if (a === "--from") { opts.from = Number(args[++i]); opts.len = Number(args[++i]); continue; }
    if (a === "--fields") { opts.fields = parseFieldsArg(args[++i]); continue; }
    if (a === "--expect-text") { (opts.expectText ||= []).push(args[++i]); continue; }
    if (a === "--expect-url") { opts.expectUrl = args[++i]; continue; }
    if (a === "--expect-title") { opts.expectTitle = args[++i]; continue; }
    if (a === "--tail") { opts.tail = true; continue; }
    if (a === "--prompt") { opts.promptText = args[++i]; continue; }
    if (a === "--wait") { opts.wait = args[++i]; continue; }
    if (a === "--timeout-ms") { opts.timeoutMs = Number(args[++i]); continue; }
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
  const res = await apiPost("/api/browser-use", { action, payload });
  if (!res) { console.error("Local API unreachable"); process.exit(1); }
  return res.json();
}

function mustOk(data) {
  if (!data?.ok) {
    console.error(data?.error || "Request failed");
    process.exit(1);
  }
  return data;
}

function printState(state) {
  console.log(`${state.url}`);
  console.log(`${state.title || ""} · ${state.actions?.length ?? 0} elements · ${state.w}x${state.h}`);
  // Page text rides along (already filtered) — no follow-up `read` round trip.
  const text = String(state.text || "").replace(/\s+/g, " ").trim();
  if (text) console.log(`text: ${text.slice(0, 800)}${text.length > 800 ? " …" : ""}`);
  // Full structural tree — sections nest by path and repeating rows collapse,
  // so a 400-element page stays readable where a flat 40-row cut misleads.
  console.log(renderTreeLines(state.actions || []));
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
  const match = raw.match(/^(click|select|type|enter|scroll|wait|run|open|read)\b\s*(.*)$/);
  if (!match) throw new Error(`Cannot parse step: ${raw}`);
  const [, op, rest] = match;
  const argv = rest.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const unq = (v) => String(v).replace(/^["']|["']$/g, "");
  switch (op) {
    case "click":
    case "select":
      // Second quoted arg = label guard: after a navigation ids are untrusted,
      // the guard makes a wrong id fail BEFORE the click.
      return { op, id: unq(argv[0]), label: argv[1] ? unq(argv[1]) : undefined };
    case "type": {
      const enter = argv.includes("--enter");
      const vals = argv.filter((a) => a !== "--enter");
      return { op, id: unq(vals[0]), text: unq(vals.slice(1).join(" ")), enter };
    }
    case "open":
      return { op, url: unq(argv[0]) };
    case "read":
      return { op, parent: unq(argv[0]) || undefined };
    case "enter":
      return { op };
    case "scroll":
      return { op, direction: unq(argv[0]) || "down" };
    case "wait": {
      const first = argv[0];
      return first && /^["']/.test(first) ? { op, text: unq(first) } : { op, ms: Number(first) || 300 };
    }
    default: { // run
      const onlyIdx = argv.indexOf("--only");
      const parentIdx = argv.indexOf("--parent");
      const expectUrlIdx = argv.indexOf("--expect-url");
      const drop = new Set([onlyIdx, onlyIdx + 1, parentIdx, parentIdx + 1,
        expectUrlIdx, expectUrlIdx + 1].filter((i) => i >= 0)); // -1+1=0 would drop the goal
      const goal = unq(argv.filter((a, i) => !drop.has(i)).join(" "));
      return {
        op: "run", goal,
        only: onlyIdx >= 0 ? unq(argv[onlyIdx + 1]) : undefined,
        parent: parentIdx >= 0 ? unq(argv[parentIdx + 1]) : undefined,
        expectUrl: expectUrlIdx >= 0 ? unq(argv[expectUrlIdx + 1]) : undefined
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

const HELP = `9remote browser — agent-driven Chrome via the host engine

  9remote browser open <url> [--attach] [--no-headless] [--wait "text"]
                                             # opens AND prints the element table
                                             # --wait: hold until the page shows the text (SPA-ready marker)
  9remote browser state                      numbered element table
  9remote browser console                    page console ring (errors first clue when nothing works)
  9remote browser read [--tail]              markdown-lite page content (cheaper than shot)
                                             # --parent SECTION: read one tree section only
                                             # --grep RE: keep matching lines only
                                             # --from OFFSET LEN: window into a long page
  9remote browser run "<sub-goal>" [--url URL] [--max-steps N] [--only REGEX] [--parent SECTION] [--fields "L=text;..."] [--prompt "text"]
                                             # --only: Jev sees only matching element labels
                                             # --parent: Jev sees only the named tree section (same-label controls in other sections drop out)
                                             # --fields: Jev picks the fields, engine types YOUR text
                                             #   (password values are masked, never sent to the model)
                                             # --expect-text "..." (repeatable) / --expect-url / --expect-title:
                                             #   engine verifies them on a fresh read — only PASSED is success
  9remote browser click <id> [options]       click table id (e3) — --wait "text" gates completion in this call
                                             # --prompt "text": answer a window.prompt() the click opens
                                             #   (native dialog, never appears in the element table)
  9remote browser clickxy <x> <y>            click exact page coordinates (custom widgets)
  9remote browser hover <id>                 move the mouse onto an element (hover menus)
  9remote browser key <enter|escape|tab|arrow...>  send a named key
  9remote browser scroll <top|bottom|px>     jump to top/bottom or scroll by pixels (negative = up)
  9remote browser back | forward | reload    browser history navigation
  9remote browser wait "<text>"              bounded wait until text/element appears
  9remote browser tab <n> | tabclose [<n>]   switch tab #n / close one (active by default)
  9remote browser type <id> "<text>" [--enter]  type exact text (+ Enter) into field
  9remote browser upload <id> <file-path>       set a file on an observed file input (CDP, no native picker)
  9remote browser download [--timeout MS]      wait for the next completed download, print its path
  9remote browser drag <from> <to>             HTML5 drag: press at <from>, release over <to>
  9remote browser chain "click e1; type e2 'hi' --enter; wait 'result'"  # many steps, ONE call
  9remote browser chain --parent Shipping "click e4 'Continue'; select e7 'Express'"
                                             # --parent scopes every step's element lookup to
                                             # one tree section; click/select take a label guard
                                             # ('Continue') — wrong id fails BEFORE the click
  9remote browser chain "open /login; run 'sign in' --expect-url /dashboard; click e4 'Profile'"
                                             # open/run --expect-url DECLARE navigation; an
                                             # undeclared route change stops the chain at once
                                               # batch Jev sub-goals in one chain too
  9remote browser enter                      press Enter
  9remote browser shot                       writes /tmp/9remote-shot-*.jpg, prints the path
  9remote browser tabs [--attach]            # list open browser tabs
  9remote browser close
  9remote browser attach                     check real-browser attach status
  9remote browser status                     config + sessions`;

export async function cmdBrowser(args) {
  const { positional, opts } = parseArgs(args);
  const [sub, ...rest] = positional;
  const isAttach = opts.mode === "attach";
  if (opts.mode === "extension") opts.profile = "__extension__"; // engine keys the shared bridge session
  const payload = (extra = {}) => ({
    profile: isAttach ? "__attach__" : undefined, // engine defaults the own-mode profile
    ...opts,
    ...extra
  });

  switch (sub) {
    case undefined:
    case "help":
      console.log(HELP);
      return;
    case "tabs": {
      const data = mustOk(await call("tabs", payload()));
      for (const t of data.tabs || []) {
        const marker = t.active ? "* " : "  ";
        console.log(`${marker}[${t.id}] ${t.title || "(untitled)"} — ${t.url}`);
      }
      return;
    }
    case "open": {
      const data = mustOk(await call("open", payload({ url: rest[0], wait: opts.wait, timeoutMs: opts.timeoutMs })));
      const modeLabel = isAttach ? "real browser (debug)" : opts.mode === "extension" ? "real browser (extension)" : "isolated Chrome";
      console.log(`opened ${rest[0]} (${modeLabel})`);
      if (data.state) printState(data.state);
      return;
    }
    case "state": {
      const data = mustOk(await call("state", payload()));
      printState(data);
      return;
    }
    case "console": {
      const data = mustOk(await call("console", payload()));
      const lines = data.lines || [];
      if (!lines.length) console.log("(console empty)");
      for (const l of lines) console.log(`${l.level.padEnd(7)} ${l.text}`);
      return;
    }
    case "read": {
      // Markdown-lite content read — --parent scopes to a tree section,
      // --grep keeps matching lines, --from OFFSET LEN windows long pages.
      const data = mustOk(await call("read", payload()));
      const text = data.text || "";
      const from = data.from || 0;
      if (from > 0 || (data.total || 0) > from + text.length) {
        console.log(`[chunk ${from}-${from + text.length} of ${data.total ?? "?"} chars]`);
      }
      console.log(opts.tail ? text.slice(Math.floor(text.length / 2)) : text);
      if (!text.trim()) console.log("(no readable text — wrong section name? read without --parent lists sections in the error)");
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
      const where = String(rest[0] || "");
      const body = ["top", "bottom"].includes(where) ? { edge: where } : { px: Number(where) };
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
      const data = mustOk(await call("wait", payload({ text: rest.join(" ") })));
      console.log(`wait "${rest.join(" ")}": ${data.found ? "FOUND" : "TIMEOUT"}`);
      if (data.state) printState(data.state);
      return;
    }
    case "tab": {
      const data = mustOk(await call("tab", payload({ index: Number(rest[0]) })));
      console.log(`active: ${data.url}`);
      if (data.state) printState(data.state);
      return;
    }
    case "tabclose": {
      const data = mustOk(await call("tabclose", payload(rest[0] ? { index: Number(rest[0]) } : {})));
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
      const steps = splitTop(rest.join(" ")).map(parseStep);
      // NOT mustOk: a failed chain still carries results/failedStep/state that
      // must reach the agent — "Request failed" alone hides where it broke.
      const data = await call("chain", payload({ steps }));
      if (!data?.results) { mustOk(data); return; }
      for (const r of data.results) {
        console.log(`  ${r.ok ? "ok" : "FAIL"} #${r.step} ${r.summary || r.op}${r.error ? ` — ${r.error}` : ""}`);
        if (r.op === "read" && r.text) {
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
}
