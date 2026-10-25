import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createApp } from "../server/app.js";

const { chromium } = await import(process.env.AREMOTE_PLAYWRIGHT_MODULE || "playwright");
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "aremote-browser-"));
const password = "browser-validation-password";
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await fn()) return; await pause(100); }
  throw new Error("Browser validation timed out");
}
let app, host, browser, port, hostLog = "";
try {
  async function start() {
    app = await createApp({ dbPath: join(root, "db.sqlite"), adminPassword: password, registrationPassword: password, webDir: join(project, "web/out") });
    app.http.listen(port || 0, "127.0.0.1");
    await once(app.http, "listening");
    port = app.http.address().port;
  }
  await start();
  const server = `http://127.0.0.1:${port}`;
  async function api(path, data, token) {
    const res = await fetch(server + path, { method: data ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
    assert.ok(res.ok, `${path}: ${res.status}`);
    return res.json();
  }
  const admin = await api("/api/admin/login", { password });
  const h = await api("/api/devices/register", { role: "host", name: "Browser validation Host", password });
  const pairing = await api("/api/admin/pairings", { role: "client", hostIds: [h.id] }, admin.token);
  mkdirSync(join(root, "host"));
  writeFileSync(join(root, "host/device.json"), JSON.stringify({ server, ...h }), { mode: 0o600 });
  const filePath = join(root, "browser-file.txt");
  writeFileSync(filePath, "ARemote browser original\n");
  host = spawn(process.execPath, ["host/aremote/index.js", "start"], { cwd: project, env: { ...process.env, AREMOTE_HOME: join(root, "host"), PORT: "0", SHELL: "/bin/bash" }, stdio: ["ignore", "pipe", "pipe"] });
  host.stdout.on("data", data => hostLog += data);
  host.stderr.on("data", data => hostLog += data);
  await until(() => { if (host.exitCode !== null) throw new Error(hostLog); return app.relay.hosts.has(h.id); });
  browser = await chromium.launch({ headless: true, ...(process.env.AREMOTE_BROWSER_EXECUTABLE ? { executablePath: process.env.AREMOTE_BROWSER_EXECUTABLE } : {}), args: ["--no-sandbox"] });
  const context = await browser.newContext();
  const external = [], errors = [], failures = [], transient = [];
  let recovering = false;
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (![server, "data:", "blob:"].includes(url.origin) && !["data:", "blob:"].includes(url.protocol)) { external.push(url.origin + url.pathname); await route.abort(); }
    else await route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => {
    if (response.status() < 400) return;
    const path = new URL(response.url()).pathname;
    const target = recovering && response.status() === 503 && path === "/api/tickets" ? transient : failures;
    target.push(`${response.status()} ${path}`);
  });
  await page.goto(server + "/login");
  await page.getByLabel("注册密码或配对码").fill(pairing.code);
  await page.getByRole("button", { name: "认证并注册此设备" }).click();
  await page.getByRole("button", { name: "Browser validation Host · 在线 — 连接" }).click();
  await page.waitForURL("**/workspace");
  await until(() => app.relay.sessions.size > 0);
  assert.equal(await page.getByRole("button", { name: "Pair Device", exact: true }).count(), 0);
  await pause(1000);
  await page.keyboard.press("Control+Shift+Enter");
  await page.locator(".xterm-helper-textarea").last().waitFor();
  await page.waitForFunction(() => new URL(location.href).searchParams.has("session"));
  const session = new URL(page.url()).searchParams.get("session");
  async function terminal(marker) {
    await page.locator(".xterm-helper-textarea").last().focus();
    await page.keyboard.type(`printf 'AREMOTE_%s\\n' '${marker}'`);
    await page.keyboard.press("Enter");
    await page.waitForFunction(value => [...document.querySelectorAll(".xterm-rows")].some(row => row.textContent.includes(value)), `AREMOTE_${marker}`);
  }
  await terminal("BROWSER_OK");
  await page.reload();
  await page.locator(".xterm-helper-textarea").last().waitFor();
  assert.equal(new URL(page.url()).searchParams.get("session"), session);
  await terminal("RELOAD_OK");
  recovering = true;
  const old = app; app = null; await old.close();
  await start();
  await until(() => app.relay.hosts.has(h.id) && app.relay.sessions.size > 0);
  await pause(1000);
  await terminal("RESTART_OK");
  recovering = false;
  await page.goto(server + `/workspace/editor?path=${encodeURIComponent(filePath)}`);
  const editor = page.locator(".cm-content[contenteditable=true]").last();
  await editor.waitFor();
  assert.match(await editor.innerText(), /ARemote browser original/);
  await editor.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("ARemote browser saved\n");
  await page.keyboard.press("Control+s");
  await until(() => readFileSync(filePath, "utf8") === "ARemote browser saved\n");
  assert.deepEqual(external, [], "Unexpected external requests");
  assert.deepEqual(errors, [], "Browser JavaScript errors");
  assert.deepEqual(failures, [], "Failed HTTP requests");
  console.log("PASS: pairing/ACL, terminal input, reload, Server restart, editor save; no external requests or HTTP/JS errors");
  console.log("Expected Host-offline responses during deliberate restart:", transient.length);
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) console.error("Browser state:", new URL(page.url()).pathname, (await page.locator("body").innerText()).slice(0,5000));
  throw error;
} finally {
  await browser?.close();
  if (host && host.exitCode === null) {
    host.kill("SIGTERM");
    await Promise.race([once(host, "exit"), pause(6000)]);
    if (host.exitCode === null) { host.kill("SIGKILL"); await once(host, "exit"); }
  }
  try { process.kill(Number(readFileSync(join(root, "host/pids/ptyDaemon.pid"), "utf8")), "SIGTERM"); } catch {}
  if (app) await app.close();
  rmSync(root, { recursive: true, force: true });
}
