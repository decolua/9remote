// Bridge for the browser extension: a localhost-only WS endpoint the
// extension's service worker connects to, plus the CdpClient-shaped ExtClient
// the engine drives it with. The wire protocol is CDP-shaped, so the engine's
// target selection and session code run unchanged for mode "extension".
// Business logic never lives here — this file only moves frames.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { getIO } from "../../transport/server.js";
import { broadcast } from "../../transport/broadcast.js";
import { createLogger } from "../../lib/logger.js";
import { CDP_CALL_TIMEOUT_MS, EXT_GUIDE_STEPS, EXT_HEARTBEAT_MS, EXT_RELAY_PATH } from "./constants.js";

const logger = createLogger("browserUse:ext");

// Persistent per-machine token — the extension's config.js embeds it, so it
// must survive host restarts (unlike the ephemeral local API token).
const TOKEN_FILE = path.join(os.homedir(), ".9remote", "browserUse", "ext-relay-token");

function relayToken() {
  try {
    const existing = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (/^[a-f0-9]{64}$/.test(existing)) return existing;
  } catch { /* first run */ }
  const token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

// ---- relay server --------------------------------------------------------------
let relayPort = null;
let sock = null; // the single extension connection (a new one replaces the old)
let handlers = new Map(); // CDP event method -> Set<fn(params, sessionId)>
const inflight = new Map(); // call id -> {resolve, reject, timer}
let nextId = 1;

// Fail-closed: only explicit loopback forms pass, anything else (including
// unparsable addresses) is refused.
const isLoopback = (addr) => addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";

export function attachBrowserRelay(server, port) {
  relayPort = port;
  relayToken();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith(EXT_RELAY_PATH)) return; // Socket.IO handles its own paths
    const url = new URL(req.url, "http://127.0.0.1");
    if (!isLoopback(req.socket.remoteAddress) || url.searchParams.get("token") !== relayToken()) {
      socket.destroy(); // loopback + secret file in the user's home — both required
      return;
    }
    wss.handleUpgrade(req, socket, head, (s) => wss.emit("connection", s));
  });
  wss.on("connection", (s) => {
    sock?.close(); // a relaunched service worker replaces the stale socket
    sock = s;
    logger.info("extension connected");
    broadcastStatus(true);
    s.on("message", (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.t === "result") resolveCall(m);
      else if (m.t === "event") dispatchEvent(m);
      if (m.t === "hello") logger.info(`extension hello proto=${m.proto}`);
      // pong / hello need no action — frames themselves keep the worker alive
    });
    s.on("close", () => {
      if (sock === s) { sock = null; failAll("CDP connection closed: extension relay down"); broadcastStatus(false); }
    });
    s.on("error", () => { /* close handler cleans up */ });
  });
  // MV3 service workers idle out after ~30s without traffic; the engine's calls
  // are bursty, so a quiet heartbeat holds the bridge open between tasks.
  setInterval(() => {
    if (sock) send({ t: "ping" });
  }, EXT_HEARTBEAT_MS).unref();
}

function send(frame) {
  try { sock?.send(JSON.stringify(frame)); } catch { /* close handler cleans up */ }
}

function resolveCall(m) {
  const entry = inflight.get(m.id);
  if (!entry) return;
  inflight.delete(m.id);
  clearTimeout(entry.timer);
  if (m.error) entry.reject(new Error(`${entry.method}: ${m.error}`));
  else entry.resolve(m.result ?? {});
}

function dispatchEvent(m) {
  const subs = handlers.get(m.method);
  if (subs) for (const fn of subs) { try { fn(m.params || {}, m.sessionId); } catch { /* subscriber error never kills the bridge */ } }
}

function failAll(reason) {
  for (const [, entry] of inflight) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  inflight.clear();
}

function broadcastStatus(connected) {
  const io = getIO();
  if (io) broadcast(io, "browserUse:ext", { connected });
}

// ---- the client the engine sees ------------------------------------------------
// Same surface as CdpClient: call/on/close/closed. The connection is shared and
// singleton (attachProbe pattern) — close() is a no-op, sessions never own it.
export function getExtClient() {
  if (!sock) return null;
  return {
    get closed() { return !sock; },
    on(method, fn) {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method).add(fn);
      return () => handlers.get(method)?.delete(fn);
    },
    call(method, params = {}, sessionId = null, timeoutMs = CDP_CALL_TIMEOUT_MS) {
      if (!sock) return Promise.reject(new Error("CDP connection closed: extension relay down"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { inflight.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
        inflight.set(id, { resolve, reject, timer, method });
        send({ t: "call", id, method, params, targetId: sessionId });
      });
    },
    close() { /* shared connection — outlives every session */ }
  };
}

// ---- status + install ----------------------------------------------------------
// The opt-in way to kill the debug banner entirely: Chrome must be (re)started
// with the switch — suppresses it for EVERY extension that session.
const SILENCE_FLAG = "--silent-debugger-extension-api";
export function extStatus() {
  const silenceCmd = process.platform === "darwin"
    ? `open -a "Google Chrome" --args ${SILENCE_FLAG}`
    : SILENCE_FLAG; // win/linux: append to the Chrome shortcut target
  return { connected: Boolean(sock), installed: fs.existsSync(installDir()), guide: EXT_GUIDE_STEPS, silenceCmd };
}

function installDir() {
  return path.join(os.homedir(), ".9remote", "browser-extension");
}

// Pristine template ships inside the package: host/extension/ in dev,
// dist/extension/ in the published bundle.
function templateDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const dir of [path.join(here, "..", "..", "extension"), path.join(here, "..", "extension")]) {
    if (fs.existsSync(path.join(dir, "manifest.json"))) return dir;
  }
  throw new Error("Extension template not found in the package");
}

// Materialize the load-unpacked folder with the relay URL baked into the
// worker (no import, no config file — no SW-module cache issues), then open the
// extensions page and reveal the folder. Only run on the host's own machine.
export function ensureExtensionInstall() {
  const dst = installDir();
  const src = templateDir();
  fs.mkdirSync(dst, { recursive: true });
  const url = `ws://127.0.0.1:${relayPort}${EXT_RELAY_PATH}?token=${relayToken()}`;
  // Recursive copy (icons/ is a subfolder) with the URL baked into the worker.
  const copyDir = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.isDirectory()) { copyDir(path.join(from, entry.name), path.join(to, entry.name)); continue; }
      if (entry.name === "background.js") {
        // 0600: the baked URL embeds the relay token — user-readable only.
        fs.writeFileSync(path.join(to, entry.name),
          fs.readFileSync(path.join(from, entry.name), "utf8").replace("__RELAY_URL__", url), { mode: 0o600 });
      } else {
        fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
      }
    }
  };
  copyDir(src, dst);
  fs.rmSync(path.join(dst, "config.js"), { force: true }); // stale from older installs
  if (process.platform === "win32") {
    spawn("explorer", [dst], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [dst], { detached: true, stdio: "ignore" }).unref();
    spawn("open", ["-a", "Google Chrome", "chrome://extensions/"], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [dst], { detached: true, stdio: "ignore" }).unref();
  }
  return { dir: dst, opened: "chrome://extensions/" };
}
