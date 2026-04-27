import chalk from "chalk";
import qrcode from "qrcode-terminal";
import { STEP, DEBUG } from "../../lib/constants.js";
import { createTempKey } from "../utils/token.js";
import { setStep } from "../core/localApi.js";
import { COLORS, WORKER_URL, TUI } from "../config.js";

export function showQRCode(url, title = "📱 Scan QR to connect:") {
  console.log(COLORS.orange(`\n${title}`));
  qrcode.generate(url, { small: true, type: "terminal", margin: 0 }, (qr) => {
    console.log(qr.trim());
  });
}

export function buildQRString(url) {
  return new Promise((resolve) => {
    qrcode.generate(url, { small: true, type: "terminal", margin: 0 }, (qr) => {
      resolve(COLORS.orangeDim("📱 Scan QR to connect:") + "\n" + qr.trim());
    });
  });
}

export async function showConnectionInfo(selectedKey, tunnelUrl) {
  const tempKeyData = await createTempKey(selectedKey, WORKER_URL);
  if (!tempKeyData) {
    console.log(chalk.red("❌ Failed to create temp key"));
    return;
  }

  const connectUrl = `${WORKER_URL}/login?k=${tempKeyData.tempKey}`;
  const width = Math.min(TUI.headerWidth, process.stdout.columns || 55);

  await setStep(STEP.READY, {
    tunnelUrl,
    oneTimeKey: tempKeyData.tempKey,
    oneTimeKeyExpiresAt: tempKeyData.expiresAt,
    permanentKey: selectedKey,
    qrUrl: connectUrl,
    workerUrl: WORKER_URL,
  });

  showQRCode(connectUrl);

  console.log(chalk.gray(`\nQR will expire in 30 minutes (one-time use)\n`));
  console.log(COLORS.orange("═".repeat(width)));
  console.log(chalk.white("App URL".padEnd(14)) + chalk.gray(`${WORKER_URL}/login`));
  console.log(chalk.white("One-Time Key".padEnd(14)) + COLORS.orange.bold(tempKeyData.tempKey));
  console.log(chalk.white("Key".padEnd(14)) + chalk.gray(selectedKey));
  console.log(COLORS.orange("═".repeat(width)));
}

export async function buildMenuHeader(oneTimeKey, permanentKey, connectUrl, tunnelUrl = "") {
  const w = Math.min(TUI.headerWidth, process.stdout.columns || TUI.headerWidth);
  const lines = [];

  if (oneTimeKey && connectUrl) {
    lines.push(await buildQRString(connectUrl));
    lines.push(chalk.gray("\nQR expires in 30 minutes (one-time use)\n"));
  } else {
    lines.push(chalk.gray("\n(One-time key used — generate a new one from menu)\n"));
  }

  lines.push(
    COLORS.orange("═".repeat(w)),
    chalk.white("App URL".padEnd(14)) + chalk.gray(`${WORKER_URL}/login`),
  );

  if (DEBUG.showTunnelUrlInMenu) {
    lines.push(chalk.white("Tunnel".padEnd(14)) + (tunnelUrl ? chalk.cyan(tunnelUrl) : chalk.gray("—")));
  }

  lines.push(
    chalk.white("One-Time Key".padEnd(14)) + (oneTimeKey ? COLORS.orange.bold(oneTimeKey) + chalk.dim("  (expires in 30m)") : chalk.gray("—")),
    chalk.white("Key".padEnd(14)) + chalk.dim(permanentKey),
    COLORS.orange("═".repeat(w)),
  );
  return lines.join("\n");
}
