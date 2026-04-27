import chalk from "chalk";
import { checkLatestVersion, stopRunningInstances } from "../utils/updateChecker.js";
import { getBannerText, selectMenu } from "../utils/tui.js";
import { getVersion } from "../session/key.js";
import { launchBackground } from "./background.js";
import { tuiMode } from "./tui.js";
import { COLORS, TUI } from "../config.js";

export async function startupMenu() {
  const version = getVersion();
  const updateInfo = await checkLatestVersion();
  const banner = getBannerText(version, updateInfo?.latest ?? null);

  const items = [];
  if (updateInfo?.latest) {
    items.push({ label: chalk.yellow(`Update to v${updateInfo.latest}`), action: "update" });
  }
  items.push(
    { label: "Open Web UI (background)", action: "ui" },
    { label: "Terminal UI", action: "tui" },
    { label: chalk.gray("Exit"), action: "exit" },
  );

  const idx = await selectMenu("", items, 0, banner);
  const action = idx >= 0 ? items[idx].action : "exit";

  if (action === "update") {
    const w = Math.min(TUI.headerWidth, process.stdout.columns || TUI.headerWidth);
    stopRunningInstances();
    console.log(COLORS.orange("\n" + "═".repeat(w)));
    console.log(chalk.gray("  ✓ Stopped running instances\n"));
    console.log(chalk.yellow("  ⬆  Run this command to update:\n"));
    console.log(chalk.white.bold(`     npm i -g 9remote@latest\n`));
    console.log(COLORS.orange("═".repeat(w)) + "\n");
    process.exit(0);
  } else if (action === "ui") {
    await launchBackground();
  } else if (action === "tui") {
    await tuiMode();
  } else {
    process.exit(0);
  }
}
