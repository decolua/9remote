import chalk from "chalk";
import { getVersion } from "../session/key.js";
import { showBanner } from "../utils/tui.js";
import { apiGet, apiPost, isServerRunning } from "../core/localApi.js";
import { WORKER_URL } from "../config.js";

// Headless CLI: drive the agent over its localhost API without the interactive TUI.
// Reuses existing endpoints so server-only (SSH, no TTY) hosts can manage keys/devices.

const HELP_ROWS = [
  ["9remote", "Interactive menu (TUI). Falls back to help with no TTY."],
  ["9remote start", "Run server + tunnel in foreground (headless)."],
  ["9remote key", "Show permanent key + connect URL."],
  ["9remote key --new", "Regenerate the permanent key."],
  ["9remote otk", "Create a fresh one-time connect key + URL."],
  ["9remote devices", "List approved devices."],
  ["9remote auto-approve <on|off>", "Toggle device auto-approve."],
  ["9remote approve <socketId>", "Approve a pending device."],
  ["9remote help", "Show this help."],
];

export function printHelp() {
  showBanner(getVersion());
  console.log(chalk.white.bold("\nUsage:\n"));
  const pad = Math.max(...HELP_ROWS.map(([c]) => c.length)) + 2;
  for (const [cmd, desc] of HELP_ROWS) {
    console.log("  " + chalk.cyan(cmd.padEnd(pad)) + chalk.gray(desc));
  }
  console.log();
}

// Guard: every command below needs the background server running.
async function requireServer() {
  if (await isServerRunning()) return true;
  console.log(chalk.red("\n✗ Server not running. Start it first: ") + chalk.cyan("9remote start") + "\n");
  return false;
}

async function cmdKey(regenerate) {
  if (!(await requireServer())) return;
  if (regenerate) {
    const r = await apiPost("/api/key/regenerate");
    const data = r && r.ok ? await r.json() : null;
    if (!data?.permanentKey) { console.log(chalk.red("\n✗ Regenerate failed\n")); return; }
    console.log(chalk.green("\n✓ New key: ") + chalk.white.bold(data.permanentKey) + "\n");
    return;
  }
  const state = (await apiGet("/api/ui/state")) || {};
  if (!state.permanentKey) { console.log(chalk.red("\n✗ No key yet. Run: ") + chalk.cyan("9remote start") + "\n"); return; }
  console.log(chalk.white("\nKey".padEnd(14)) + chalk.white.bold(state.permanentKey));
  if (state.qrUrl) console.log(chalk.white("Connect URL".padEnd(14)) + chalk.cyan(state.qrUrl));
  console.log(chalk.white("App URL".padEnd(14)) + chalk.gray(`${WORKER_URL}/login`) + "\n");
}

async function cmdOtk() {
  if (!(await requireServer())) return;
  const r = await apiPost("/api/key/one-time");
  const data = r && r.ok ? await r.json() : null;
  if (!data?.qrUrl) { console.log(chalk.red("\n✗ Failed to create one-time key\n")); return; }
  console.log(chalk.green("\n✓ One-time key (30 min): ") + chalk.white.bold(data.oneTimeKey));
  console.log(chalk.white("Connect URL ") + chalk.cyan(data.qrUrl) + "\n");
}

async function cmdDevices() {
  if (!(await requireServer())) return;
  const d = (await apiGet("/api/device/approved")) || {};
  const devices = d.devices || [];
  const auto = (await apiGet("/api/device/auto-approve")) || {};
  console.log(chalk.white(`\nAuto-approve: `) + (auto.enabled ? chalk.green("ON") : chalk.gray("OFF")));
  if (!devices.length) { console.log(chalk.gray("No approved devices\n")); return; }
  console.log(chalk.white(`Approved devices (${devices.length}):`));
  for (const dev of devices) console.log("  " + chalk.cyan(dev.deviceId));
  console.log();
}

async function cmdAutoApprove(value) {
  if (!(await requireServer())) return;
  const on = value === "on";
  if (value !== "on" && value !== "off") { console.log(chalk.red("\n✗ Usage: 9remote auto-approve <on|off>\n")); return; }
  const r = await apiPost("/api/device/auto-approve", { enabled: on });
  const data = r && r.ok ? await r.json() : null;
  console.log(chalk.green("\n✓ Auto-approve: ") + (data?.enabled ? chalk.green("ON") : chalk.gray("OFF")) + "\n");
}

async function cmdApprove(socketId) {
  if (!(await requireServer())) return;
  if (!socketId) {
    const d = (await apiGet("/api/device/pending")) || {};
    const pending = d.pending || [];
    if (!pending.length) { console.log(chalk.gray("\nNo pending devices\n")); return; }
    console.log(chalk.white(`\nPending devices (${pending.length}):`));
    for (const p of pending) console.log("  " + chalk.cyan(p.socketId) + chalk.gray(`  ${p.deviceId?.slice(0, 8) || ""}  ${p.ip || ""}`));
    console.log(chalk.gray("\nApprove with: ") + chalk.cyan("9remote approve <socketId>") + "\n");
    return;
  }
  const r = await apiPost("/api/device/approve", { socketId });
  const data = r && r.ok ? await r.json() : null;
  console.log(data?.ok ? chalk.green("\n✓ Approved\n") : chalk.red("\n✗ Approve failed (invalid socketId?)\n"));
}

// Returns true if the arg was a headless command (already handled), false otherwise.
export async function runHeadlessCommand(argv) {
  const cmd = argv[2];
  const args = argv.slice(3);
  switch (cmd) {
    case "help": case "-h": case "--help": printHelp(); return true;
    case "key": await cmdKey(args.includes("--new")); return true;
    case "otk": await cmdOtk(); return true;
    case "devices": await cmdDevices(); return true;
    case "auto-approve": await cmdAutoApprove(args[0]); return true;
    case "approve": await cmdApprove(args[0]); return true;
    default: return false;
  }
}
