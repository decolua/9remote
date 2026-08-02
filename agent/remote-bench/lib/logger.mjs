// Logger: human console-mirror file + JSONL structured events + summary.json.
import { mkdirSync, appendFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

export class Logger {
  constructor(dir) {
    this.dir = fileURLToPath(dir.href ? dir.href : new URL(dir, "file://"));
    mkdirSync(this.dir, { recursive: true });
    const ts = stamp();
    this.logPath = path.join(this.dir, `log_${ts}.log`);
    this.jsonlPath = path.join(this.dir, `log_${ts}.jsonl`);
    this.summaryPath = path.join(this.dir, `summary.json`);
    this._events = [];
    this._write(`=== remote-bench run ${ts} ===`);
  }

  _now() { return Date.now(); }

  _write(line) {
    console.log(line);
    appendFileSync(this.logPath, line + "\n", "utf8");
  }

  _emit(level, msg, data) {
    const ev = { ts: this._now(), level, msg, ...(data || {}) };
    this._events.push(ev);
    appendFileSync(this.jsonlPath, JSON.stringify(ev) + "\n", "utf8");
    const tail = data && Object.keys(data).length ? " " + JSON.stringify(data) : "";
    const tag = level === "info" ? "" : `[${level.toUpperCase()}] `;
    this._write(`${tag}${msg}${tail}`);
  }

  info(msg, data) { this._emit("info", msg, data); }
  warn(msg, data) { this._emit("warn", msg, data); }
  error(msg, data) { this._emit("error", msg, data); }
  event(cat, data) { this._emit("info", `[${cat}]`, data); }

  // Log a bench step result (rows + flags).
  step(name, result) {
    this.event("step", { name, ...result });
    if (result && result.rows) {
      this._write(`── ${name} ──`);
      for (const r of result.rows) {
        this._write(`  ${r.name.padEnd(40)} med ${fmt7(r.median)} min ${fmt7(r.min)} mean ${fmt7(r.mean)}`);
      }
    }
  }

  summary(obj) {
    writeFileSync(this.summaryPath, JSON.stringify(obj, null, 2), "utf8");
    this.info("[summary] written", { path: this.summaryPath });
  }

  async flush() { /* sync writes; placeholder for future async sink */ }
}

function fmt7(n) { return (typeof n === "number" ? n.toFixed(1) : String(n)).padStart(7); }

// Deterministic-ish timestamp (seconds precision, no Date.now in workflow-safe code paths).
function stamp() {
  const d = new Date();
  const p = (x, n = 2) => String(x).padStart(n, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
