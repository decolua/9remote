// Build the DXGI DDA probe: detect csc, download+cache SharpDX DLLs, compile.
// Returns the exe path on success, throws on any failure (caller falls back).
import { existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const VER = "4.2.0";
const PKGS = ["sharpdx", "sharpdx.dxgi", "sharpdx.direct3d11"];
const DLL = { "sharpdx": "SharpDX.dll", "sharpdx.dxgi": "SharpDX.DXGI.dll", "sharpdx.direct3d11": "SharpDX.Direct3D11.dll" };

const CSC_PATHS = [
  "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",
  "C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe"
];

export function findCsc() {
  for (const p of CSC_PATHS) if (existsSync(p)) return p;
  return null;
}

function run(cmd, log) {
  if (log) log.info(`  $ ${cmd}`);
  execSync(cmd, { stdio: "pipe", windowsHide: true });
}

export async function buildProbe({ log } = {}) {
  const probeDir = fileURLToPath(new URL("./", import.meta.url));
  const libDir = path.join(probeDir, "lib");
  mkdirSync(libDir, { recursive: true });

  const csc = findCsc();
  if (!csc) throw new Error(".NET Framework csc.exe not found (no DXGI native probe)");

  // Download + extract SharpDX DLLs (cached in lib/)
  for (const pkg of PKGS) {
    const dllName = DLL[pkg];
    const dllPath = path.join(libDir, dllName);
    if (existsSync(dllPath)) { continue; }
    const url = `https://api.nuget.org/v3-flatcontainer/${pkg}/${VER}/${pkg}.${VER}.nupkg`;
    const zip = path.join(libDir, `${pkg}.zip`);
    if (log) log.info(`  download ${pkg} ${VER}`);
    run(`curl -sSL -o "${zip}" "${url}"`);
    // Expand only lib/net40/<Dll> to lib/
    run(`powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[System.IO.Compression.ZipFile]::OpenRead('${zip}'); $e=$z.Entries | Where-Object { $_.FullName -eq 'lib/net40/${dllName}' }; [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e[0], '${dllPath}', $true); $z.Dispose()"`, log);
    run(`del "${zip}"`);
  }

  // Compile
  const exe = path.join(probeDir, "probe_dxgi2.exe");
  const refs = PKGS.map((p) => `-r:"${path.join(libDir, DLL[p])}"`).join(" ");
  run(`"${csc}" -nologo -unsafe -out:"${exe}" ${refs} "${path.join(probeDir, "probe_dxgi2.cs")}"`, log);
  if (!existsSync(exe)) throw new Error("csc produced no exe");

  // CLR resolves DLLs next to the exe at runtime — copy them out of lib/.
  for (const pkg of PKGS) {
    const dll = DLL[pkg];
    const from = path.join(libDir, dll);
    const to = path.join(probeDir, dll);
    run(`copy /Y "${from}" "${to}" >NUL`, log);
  }
  return exe;
}
