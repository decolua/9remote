// `9remote browser …` — headless commands that drive the running host's local
// API (same pattern as key/devices). Output is agent-friendly: element tables
// and run outcomes print as compact text, everything else as JSON.
import fs from "node:fs";
import { apiPost, isServerRunning } from "../core/localApi.js";

const PROFILE_FLAGS = ["--profile", "-p"];

function parseArgs(args) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (PROFILE_FLAGS.includes(a)) { opts.profile = args[++i]; continue; }
    if (a === "--url") { opts.url = args[++i]; continue; }
    if (a === "--max-steps") { opts.maxSteps = Number(args[++i]); continue; }
    if (a === "--attach") { opts.mode = "attach"; continue; }
    if (a === "--no-headless") { opts.headless = false; continue; }
    if (a === "--enter") { opts.enter = true; continue; }
    if (a === "--only") { opts.only = args[++i]; continue; }
    positional.push(a);
  }
  return { positional, opts };
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
  for (const a of (state.actions || []).slice(0, 60)) {
    const value = a.kind === "fill" && a.value ? ` = ${a.value.slice(0, 30)}` : "";
    console.log(`  [${a.id}] ${a.kind.padEnd(6)} ${String(a.label).slice(0, 70)}${value}`);
  }
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
  const match = raw.match(/^(click|select|type|enter|scroll|wait|run)\b\s*(.*)$/);
  if (!match) throw new Error(`Cannot parse step: ${raw}`);
  const [, op, rest] = match;
  const argv = rest.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const unq = (v) => String(v).replace(/^["']|["']$/g, "");
  switch (op) {
    case "click":
    case "select":
      return { op, id: unq(argv[0]) };
    case "type": {
      const enter = argv.includes("--enter");
      const vals = argv.filter((a) => a !== "--enter");
      return { op, id: unq(vals[0]), text: unq(vals.slice(1).join(" ")), enter };
    }
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
      const goal = unq(argv.filter((a, i) => i !== onlyIdx && i !== onlyIdx + 1).join(" "));
      return { op: "run", goal, only: onlyIdx >= 0 ? unq(argv[onlyIdx + 1]) : undefined };
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
  if (result.outcome === "needs_verification") console.log("element table below — verify before claiming success (shot for visual).");
}

const HELP = `9remote browser — agent-driven Chrome via the host engine

  9remote browser open <url> [--profile N] [--attach] [--no-headless]
                                             # opens AND prints the element table
  9remote browser state [--profile N]        numbered element table
  9remote browser run "<sub-goal>" [--url URL] [--max-steps N] [--only REGEX] [--profile N]
                                             # --only: Jev sees only matching element labels
  9remote browser click <id> [options]       click table id (e3)
  9remote browser type <id> "<text>" [--enter]  type exact text (+ Enter) into field
  9remote browser chain "click e1; type e2 'hi' --enter; wait 'result'"  # many steps, ONE call
  9remote browser enter                      press Enter
  9remote browser shot [--profile N]         writes /tmp/9remote-shot-*.jpg, prints the path
  9remote browser close [--profile N]
  9remote browser profiles list|create <name>|delete <name>
  9remote browser attach                     check real-browser attach status
  9remote browser status                     config + sessions`;

export async function cmdBrowser(args) {
  const { positional, opts } = parseArgs(args);
  const [sub, ...rest] = positional;
  const payload = (extra = {}) => ({ profile: opts.profile, ...opts, ...extra });

  switch (sub) {
    case undefined:
    case "help":
      console.log(HELP);
      return;
    case "open": {
      const data = mustOk(await call("open", payload({ url: rest[0] })));
      console.log(`opened ${rest[0]} (profile ${opts.profile || "default"})`);
      if (data.state) printState(data.state);
      return;
    }
    case "state": {
      const data = mustOk(await call("state", payload()));
      printState(data);
      return;
    }
    case "run": {
      const data = mustOk(await call("run", payload({ goal: rest.join(" ") })));
      printRun(data);
      if (data.state) printState(data.state);
      return;
    }
    case "click": {
      const data = mustOk(await call("click", payload({ id: rest[0] })));
      console.log(`clicked ${rest[0]}`);
      if (data.state) printState(data.state);
      return;
    }
    case "type": {
      const data = mustOk(await call("type", payload({ id: rest[0], text: rest.slice(1).join(" "), enter: Boolean(opts.enter) })));
      console.log(`typed into ${rest[0]}${opts.enter ? " + enter" : ""}`);
      if (data.state) printState(data.state);
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
      const data = mustOk(await call("chain", payload({ steps })));
      for (const r of data.results) {
        console.log(`  ${r.ok ? "ok" : "FAIL"} #${r.step} ${r.summary || r.op}${r.error ? ` — ${r.error}` : ""}`);
      }
      if (data.failedStep) console.error(`chain stopped at step ${data.failedStep}`);
      if (data.state) printState(data.state);
      return;
    }
    case "close":
      mustOk(await call("close", payload()));
      console.log("closed");
      return;
    case "profiles": {
      if (rest[0] === "create") { mustOk(await call("profiles.create", { name: rest[1] })); console.log(`created ${rest[1]}`); return; }
      if (rest[0] === "delete") { mustOk(await call("profiles.delete", { name: rest[1] })); console.log(`deleted ${rest[1]}`); return; }
      if (rest[0] === "rename") { mustOk(await call("profiles.rename", { from: rest[1], to: rest[2] })); console.log(`renamed ${rest[1]} -> ${rest[2]}`); return; }
      const data = mustOk(await call("profiles.list", {}));
      console.log((data.profiles || []).map((p) => p.name).join("\n"));
      return;
    }
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
