/**
 * System tray module — optional, silent fail if not supported
 */

import { exec } from "child_process";

let trayInstance = null;

// 64x64 PNG base64 — generated from agent/ui/public/favicon.svg
const TRAY_ICON = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAACXBIWXMAAAsTAAALEwEAmpwYAAAD0ElEQVR4nO2bS0hUURjH70rnHCejJ4pBEFpttNy1qEU727i794yPlF4LiRSjiIIWTmEQQpFkORq1iEKrpYQtekjNRAWVLgpcZFqEMwWVGTOa/ePMHYvBe8frzL1zZs70wbe7M3z/33l95/EpikVD3cpCqK4aMNIDRp+BkSA0OgNGIdSjMZBgLCYfNJcH1auWWdW1qIHlbQQjV8DotHCx1n0aGulFTV5Z8sJVhYCRDjA6mwGCku8dGjmLRsW1NPE1eWVgZES4APs8gDpabE28h1bGxpTooO3uDRPwFFRYafmg8GCdhKDSImPxjYoLjLwSHqTz/oLPbwsBsOiEJzq4NPUE0maw1NHsne2X7lNxQwH6Oi86qDT3Atr1L8PLriTHLgA/ohmjnt5mQEBC3MWUWG6fAcEI6QXdir6JsPiDvcXArdPA0A2gc494Aal7QIFGQpY+ri0E3r1GnN29mOU9gEzyHhCx9LG3CobW5xUvJHkPK5Y/NgPArbdZtJCkXbH8sdEQmLe5X8C5eskBMAo0lQLBMWMIsxGgvVpyAIwCLeXA10ljCOFp4OROyQEwChzfDvycMobw/TNwuFJyACw2Kc6EjSF8+QAc3Cw5AEaBDqZPgEb2aRQ4sF5yAIwCPYdgaqPPgca1kgNgVE+GzGzkAVC/QnIAjAIDF8whPOkHPG7JAXgKgIfXzSEMdksOgPFscTnwctAcQgbuGxTb/7RhNfDWbw7h2lHJAbDYucHYsDGA33PA+d2SA2B831AGhMaNIfAE6tg2yQEwCrRuAb6FjCHc8wkXj/8A6P8hoDjyx/vXARNvcnQSbFhkGbx6RLhogYlQm3DBzgHw5HoqPNBpLv5xn+Sbof5T5uKH70u+He5tzuEDkY4ER2J8GdxXIlygcwC8uxY5FN0kXJxzAE7sSHws3rpVuDDnALRU5PDFSFMpEHpv/9UYf2swdBMI3Ene/bf1twv8LCKrLkf7EpwoJ2M8Rh6r7QC8Dl2Pm22XUzEe6xIARFICkOpBp1gAYfFPZEQOAU1/IiP+kZS4STDAn8n5bBOSfX5ZidbYiA9EkBOVl8a4o89GhQeTZueaVcWtvxfmBUa51/q++EqRTCiBS59HUJu/Ib5mgFdXiQ8sPa6RMyYlMzQgPDjn3Y8qJd+4bkilRdDouLwtTz9CJSWJK8c8BRXR6ir5xI9DLShPKH7eoLrXgNFHwoO2z/2m5XJmxscJr67K8hwhAkbaTce8FYvNC11ZBYLHqtHuBUtdKgaeMTIX4/kzNPqU76Qsb6WdbmUeC4+J0UtQXdrfDM+C/QFrX3GhHKhdvQAAAABJRU5ErkJggg==";

function getIconBase64() {
  return TRAY_ICON;
}

function isTraySupported() {
  const platform = process.platform;
  if (!["darwin", "win32", "linux"].includes(platform)) return false;
  if (platform === "linux" && !process.env.DISPLAY) return false;
  return true;
}

/**
 * Initialize system tray
 * @param {{ port: number, onQuit: () => void, onOpenUI: () => void }} options
 */
export async function initTray({ port, onQuit, onOpenUI }) {
  if (!isTraySupported()) return null;

  try {
    const mod = await import("systray");
    const SysTray = mod.default?.default || mod.default;

    const isWin = process.platform === "win32";
    const menu = {
      icon: getIconBase64(),
      title: isWin ? `9Remote - Port ${port}` : "",
      tooltip: `9Remote - Port ${port}`,
      items: [
        { title: `9Remote (Port ${port})`, tooltip: "Server is running", enabled: false },
        { title: "Open Web UI", tooltip: "Open in browser", enabled: true },
        { title: "Quit", tooltip: "Stop server and exit", enabled: true },
      ],
    };

    trayInstance = new SysTray({ menu, debug: false, copyDir: true });

    trayInstance.onClick((action) => {
      if (action.item.title === "Open Web UI") {
        onOpenUI?.();
      } else if (action.item.title === "Quit") {
        onQuit?.();
        killTray();
        setTimeout(() => process.exit(0), 500);
      }
    });

    trayInstance.onReady(() => {});
    trayInstance.onError(() => {});

    return trayInstance;
  } catch {
    return null;
  }
}

export function killTray() {
  const instance = trayInstance;
  trayInstance = null;
  if (instance) {
    try { instance.kill(true); } catch {}
  }
}

export function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === "darwin" ? `open "${url}"`
    : platform === "win32" ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {});
}
