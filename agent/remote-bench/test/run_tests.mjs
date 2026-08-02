// TDD runner — runs every *.test.mjs, collects pass/fail, exits non-zero on any fail.
import { readdir } from "fs/promises";

const dir = new URL("./", import.meta.url);
const files = (await readdir(dir)).filter((f) => f.endsWith(".test.mjs")).sort();

let pass = 0, fail = 0;
for (const f of files) {
  const mod = await import(new URL(f, dir));
  const tests = Object.entries(mod).filter(([k]) => k.startsWith("test") || typeof mod[k] === "function");
  // Each test module exports an async run() returning {pass, fail, name}
  if (typeof mod.run === "function") {
    const r = await mod.run();
    console.log(`${r.fail === 0 ? "✓" : "✗"} ${f}  ${r.pass}/${r.pass + r.fail}`);
    pass += r.pass; fail += r.fail;
  }
}
console.log(`\nTOTAL ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
