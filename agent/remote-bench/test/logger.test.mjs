// Test: logger writes human + jsonl + summary, formats correctly.
import { Logger } from "../lib/logger.mjs";
import { readFileSync, existsSync, rmSync } from "fs";

const TMP = new URL("./.tmplog/", import.meta.url);
try { rmSync(TMP, { recursive: true, force: true }); } catch {}

export async function run() {
  let pass = 0, fail = 0;
  const ok = (c, m) => c ? pass++ : (fail++, console.log("  FAIL " + m));

  const log = new Logger(TMP);
  log.info("hello", { n: 1 });
  log.warn("careful");
  log.error("boom");
  log.event("step", { name: "capture", ms: 12.3 });
  await log.flush();

  ok(existsSync(log.logPath), `log file exists: ${log.logPath}`);
  ok(existsSync(log.jsonlPath), `jsonl file exists: ${log.jsonlPath}`);

  const human = readFileSync(log.logPath, "utf8");
  ok(human.includes("hello"), "human has info msg");
  ok(human.includes("[WARN]") || human.includes("careful"), "human has warn");
  ok(human.includes("boom"), "human has error");

  const lines = readFileSync(log.jsonlPath, "utf8").trim().split("\n");
  ok(lines.length >= 4, `jsonl has >=4 events, got ${lines.length}`);
  const ev = JSON.parse(lines[0]);
  ok(typeof ev.ts === "number" && ev.level && ev.msg !== undefined, "jsonl event shape {ts,level,msg}");

  log.summary({ total: pass + fail, note: "t" });
  await log.flush();
  ok(existsSync(log.summaryPath), "summary file written");

  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  return { pass, fail };
}
