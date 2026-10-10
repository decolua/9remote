// Full-stack A/B: real Chrome + real Jev on an ambiguous page — the same task
// with and without --parent scoping. Success = the Shipping Save was clicked
// (page title flips to SHIP; the wrong pick flips it to BILL).
// Run: node host/test/browserUseParentE2e.mjs   (free lane, no key)
import "./chromeGuard.mjs";
import http from "node:http";
import { withSession, profiles } from "../features/browserUse/engine.js";
import { runTask } from "../features/browserUse/agentLoop.js";
import { decide } from "../features/browserUse/jevClient.js";

// Hard shape: named card sections wrapping IDENTICALLY-named inner panels —
// ctx (closest section) is "Logs" for BOTH buttons, only the tree path
// (Card > Logs) tells them apart. Same shape the payload probe proved hard.
const filler = Array.from({ length: 120 }, (_, i) =>
  `<a href="#" onclick="return false">Invoice ${String(i + 1).padStart(3, "0")}</a>`).join(" ");
const PAGE = `<!doctype html><html><body>
  <section aria-label="Billing"><div aria-label="Logs"><button onclick="document.title='BILL'">Save</button></div></section>
  <section aria-label="Shipping"><div aria-label="Logs"><button onclick="document.title='SHIP'">Save</button></div></section>
  <div>${filler}</div>
</body></html>`;

const srv = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(PAGE);
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${srv.address().port}/`;

const RUNS = 3;
const tally = { plain: 0, parent: 0 };
for (let i = 0; i < RUNS * 2; i++) {
  const useParent = i % 2; // alternate to kill ordering bias
  const profile = `parent-e2e-${Date.now()}-${i}`;
  let payloadChars = 0;
  const measure = async (body, config) => {
    payloadChars = payloadChars || JSON.stringify(body).length; // first call's payload
    return decide(body, config);
  };
  const result = await withSession({ profile, url, headless: true }, async (session) => {
    const opts = { goal: "press Save", decide: measure, maxSteps: 4, maxMs: 45000 };
    if (useParent) opts.parent = "Shipping";
    else opts.goal = "press the Save button in the Shipping card";
    const r = await runTask(session, opts);
    const title = await session.steady().then((s) => s.title).catch(() => null);
    return { ...r, title };
  });
  const ok = result.title === "SHIP";
  tally[useParent ? "parent" : "plain"] += ok;
  console.log(`run ${i + 1}  ${useParent ? "parent" : "plain "}  ` +
    `${ok ? "✓ SHIP" : `✗ title=${result.title} outcome=${result.outcome}`}  ` +
    `steps=${result.metrics.steps} calls=${result.metrics.modelCalls} payload=${Math.round(payloadChars / 1024)}KB`);
  await profiles.remove(profile).catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
}
srv.close();
console.log(`\nno-parent (như trước đây): ${tally.plain}/${RUNS} đúng nút Shipping`);
console.log(`--parent Shipping        : ${tally.parent}/${RUNS} đúng nút Shipping`);
process.exit(0);
