# 9remote Screen Capture Benchmark

Portable benchmark for screen capture & image encoding performance.

## 📦 How to Use (Copy & Run)

### Windows

1. **Install Node.js 18+** from https://nodejs.org/en/download (if not installed)
2. Copy this entire `benchmark/` folder to the Windows machine
3. **Double-click `run-windows.bat`**
4. Wait for auto-install + run (~1-2 min first time)
5. Results saved to `results/win32-x64/latest.md`

### macOS / Linux

```bash
cd benchmark
./run-mac.sh
```

Or manually:

```bash
npm install
node screenCapture.js   # auto-detects OS
```

## 📂 Structure

```
benchmark/
  package.json              # self-contained deps
  screenCapture.js          # universal launcher (auto-detects OS)
  screenCapture.win.js      # Windows-specific (DXGI, no robotjs)
  screenCapture.mac.js      # macOS/Linux (with robotjs)
  run-windows.bat           # Windows 1-click runner
  run-mac.sh                # macOS/Linux 1-click runner
  results/
    darwin-arm64/           # Mac results
    win32-x64/              # Windows results
    linux-x64/              # Linux results
  output/
    <platform>/             # Captured images per OS
```

## 🔬 What's Tested

### Capture Libraries
| Library | macOS | Windows | API |
|---------|-------|---------|-----|
| `@hurdlegroup/robotjs` | ✅ | ⚠️ (needs build tools) | CGWindowList (mac), BitBlt GDI (win) |
| `node-screenshots` | ✅ | ✅ | **DXGI Desktop Duplication** on Win (GPU framebuffer) |
| `screenshot-desktop` | ✅ | ✅ | Spawn `screencapture` (mac) / PowerShell (win) |

### Encoders
| Encoder | Notes |
|---------|-------|
| `sharp` | libvips + libjpeg-turbo, resize+encode pipeline |
| `@julusian/jpeg-turbo` | Direct libjpeg-turbo SIMD binding, JPEG-only |
| `@napi-rs/image` | Rust-based, fast WebP/AVIF |

## 🪟 Windows Notes

The Windows script benchmarks BOTH capture APIs so you can compare:

- **`node-screenshots`** uses **DXGI Desktop Duplication API** — reads directly from GPU framebuffer (fastest official Windows API, same as OBS/Zoom use)
- **`@hurdlegroup/robotjs`** uses **BitBlt GDI** — traditional CPU-based capture, also provides mouse/keyboard control

`robotjs` is marked as `optionalDependency`. If `npm install` fails to build it (missing Python/Visual Studio Build Tools), the script auto-skips robotjs tests and continues with the rest.

### Best combo on Windows:
**DXGI (node-screenshots) → jpeg-turbo SIMD encode** — fastest end-to-end pipeline.

## 📊 Reading Results

Each run generates:
- `results/<os>/YYYY-MM-DDTHH-MM-SS.md` — human-readable report with winners
- `results/<os>/YYYY-MM-DDTHH-MM-SS.json` — raw data for comparison
- `results/<os>/latest.md` + `latest.json` — always points to last run
- `output/<os>/*.jpg|png|webp` — captured/encoded images for visual inspection
