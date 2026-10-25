import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.js";

const password = "http-test-admin-password";
async function fixture(t, config = {}) {
  const app = await createApp({ adminPassword: password, ...config });
  app.http.listen(0, "127.0.0.1");
  await once(app.http, "listening");
  t.after(() => app.close());
  return `http://127.0.0.1:${app.http.address().port}`;
}
function login(url, ip, value = "incorrect-password") {
  return fetch(url + "/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: JSON.stringify({ password: value }),
  });
}
test("trusted proxy clients have separate limits; direct clients cannot spoof them", async t => {
  const proxy = await fixture(t, { trustProxy: true });
  for (let i = 0; i < 20; i++) assert.equal((await login(proxy, "198.51.100.10")).status, 401);
  assert.equal((await login(proxy, "198.51.100.10", password)).status, 429);
  assert.equal((await login(proxy, "198.51.100.11", password)).status, 200);
  const direct = await fixture(t);
  for (let i = 0; i < 20; i++) assert.equal((await login(direct, `198.51.100.${i + 1}`)).status, 401);
  assert.equal((await login(direct, "198.51.100.99", password)).status, 429);
});
test("static client excludes old administration pages and rejects malformed paths", async t => {
  const root = mkdtempSync(join(tmpdir(), "aremote-http-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "admin"));
  mkdirSync(join(root, "fonts"));
  writeFileSync(join(root, "login.html"), "ARemote Login");
  writeFileSync(join(root, "admin/login.html"), "legacy admin");
  writeFileSync(join(root, "download.html"), "legacy download");
  writeFileSync(join(root, "admin.html"), "legacy root admin");
  writeFileSync(join(root, "fonts/icon.ttf"), "font-data");
  const url = await fixture(t, { webDir: root });
  assert.equal(await (await fetch(url + "/")).text(), "ARemote Login");
  assert.match(await (await fetch(url + "/admin")).text(), /ARemote/);
  for (const path of ["/admin/", "/admin/login", "/ad%6din/login", "/admin.html", "/download", "/download.html"]) {
    assert.equal((await fetch(url + path)).status, 404, path);
  }
  assert.equal((await fetch(url + "/%")).status, 400);
  assert.equal((await fetch(url + "/fonts/icon.ttf")).headers.get("content-type"), "font/ttf");
  const terminal = await fetch(url + "/workspace/terminal/session-123", { redirect: "manual" });
  assert.equal(terminal.status, 302);
  assert.equal(terminal.headers.get("location"), "/workspace/terminal/default?session=session-123");
});
