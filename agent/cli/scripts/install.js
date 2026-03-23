#!/usr/bin/env node

/**
 * Postinstall: Check robotjs installation status
 * robotjs is now in optionalDependencies - npm handles installation
 */

async function checkRobotjs() {
  try {
    require.resolve("@hurdlegroup/robotjs");
    console.log("✅ robotjs installed (Remote desktop available)");
  } catch {
    console.log("ℹ️  robotjs not available (Remote desktop disabled)");
    console.log("   This is normal on headless Linux systems.");
  }
}

// Run and always exit successfully
checkRobotjs().then(() => process.exit(0)).catch(() => process.exit(0));
