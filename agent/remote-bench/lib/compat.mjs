// Win compatibility detection: OS, dlls, GPU adapter, .NET csc, Node version.
import { execSync } from "child_process";
import { existsSync } from "fs";
import os from "os";

const SYS = "C:/Windows/System32";

export async function detectCompat() {
  const isWin = process.platform === "win32";
  const node = process.versions.node;

  const hasD3D11 = isWin ? existsSync(`${SYS}/d3d11.dll`) : false;
  const hasDXGI = isWin ? existsSync(`${SYS}/dxgi.dll`) : false;
  const hasOpenCL = isWin ? existsSync(`${SYS}/opencl.dll`) : false;
  const hasD2D1 = isWin ? existsSync(`${SYS}/d2d1.dll`) : false;

  let gpu = "unknown";
  let adapters = [];
  let cscPath = null;

  if (isWin) {
    try {
      gpu = execSync(
        `powershell -NoProfile -Command "(Get-WmiObject Win32_VideoController).Name"`,
        { encoding: "utf8", windowsHide: true }
      ).trim().split(/\r?\n/).filter(Boolean).join(", ");
    } catch { gpu = "unknown"; }

    // enumerate DXGI adapters
    try {
      const out = execSync(
        `powershell -NoProfile -Command "Get-WmiObject Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json"`,
        { encoding: "utf8", windowsHide: true }
      ).trim();
      adapters = JSON.parse(out);
      if (!Array.isArray(adapters)) adapters = [adapters];
    } catch { adapters = []; }

    // find .NET Framework csc
    cscPath = findCsc();
  }

  return {
    isWin, node,
    os: `${os.type()} ${os.release()}`,
    cpu: os.cpus()[0]?.model || "unknown",
    memGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
    hasD3D11, hasDXGI, hasOpenCL, hasD2D1,
    gpu, adapters, cscPath,
    openCLusable: hasOpenCL
  };
}

function findCsc() {
  const dirs = [
    "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",
    "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe"
  ];
  const seen = new Set();
  for (const d of dirs) {
    if (seen.has(d)) continue;
    seen.add(d);
    if (existsSync(d)) return d;
  }
  return null;
}
