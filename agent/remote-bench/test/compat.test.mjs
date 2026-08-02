// Test: compat detect — OS, dlls, GPU, .NET csc, Node. Non-Win skips gracefully.
import { detectCompat } from "../lib/compat.mjs";

export async function run() {
  let pass = 0, fail = 0;
  const ok = (c, m) => c ? pass++ : (fail++, console.log("  FAIL " + m));

  const c = await detectCompat();
  ok(typeof c.isWin === "boolean", "isWin boolean");
  ok(typeof c.node === "string", `node version string: ${c.node}`);
  ok(typeof c.hasD3D11 === "boolean", "hasD3D11 boolean");
  ok(typeof c.hasDXGI === "boolean", "hasDXGI boolean");
  ok(typeof c.hasOpenCL === "boolean", "hasOpenCL boolean");
  ok(typeof c.gpu === "string" && c.gpu.length > 0, `gpu string: ${c.gpu}`);
  ok(typeof c.cscPath === "string" || c.cscPath === null, "cscPath string|null");
  ok(Array.isArray(c.adapters), `adapters array: ${c.adapters.length}`);
  return { pass, fail };
}
