# Remote Desktop

Tile-based screen streaming. Hash-diff, focus region, adaptive quality.

## Pipeline

```
capture (robotjs|nodeScreenshots)
  → BGRA/RGBA buffer + width/height
  → getSharedScreenCapture  (cache TTL 100ms)
  → calculateTileChecksumDirect  (hash từ buffer, không cắt tile)
  → so prev hash → tile changed mới đi tiếp
  → extractTile  (Buffer.copy theo row)
  → compressTileImage  (sharp resize lanczos3 + BGRA→RGBA + JPEG)
  → encodeTilesBatch  (binary header + tiles)
  → protocol.sendTiles
      RTC: chunks dcChunkSize=8 tiles/msg, DC binary
      WS:  chunks wsChunkSize=32 tiles/msg, "tiles-bin-v2"
══════ network ══════
  → tileDecoder.worker  (parse + createImageBitmap)
  → useTiles.handleTilesData  (rAF queue + drawImage flush)
```

## Platform defaults

| OS | capture | encoder | tileSize | inputFormat |
|---|---|---|---|---|
| darwin | robotjs | sharp | 128 | bgra |
| win32 | nodeScreenshots | sharp | 256 | rgba |
| linux | nodeScreenshots | sharp | 256 | rgba |

`REMOTE_CONFIG.pipeline.{captureLib, encoder, inputFormat, tileSize, jpegQuality:50, outputScale:1}`

## Tile binary format

```
Batch header (12B):
  tileCount(4 LE) timestamp(8 F64 BE)

Tile v1 header (24B):
  tileIndex(4) x(4) y(4) width(4) height(4) imageSize(4)

Tile v2 header (28B):
  v1 + hash(4)

Body: <imageSize> bytes JPEG
```

## Quality profiles

```js
qualityProfiles = [
  { minZoom: 3.0, outputScale: 1.00, jpegQuality: 60 },
  { minZoom: 2.0, outputScale: 1.00, jpegQuality: 55 },
  { minZoom: 1.3, outputScale: 0.90, jpegQuality: 50 },
  { minZoom: 1.0, outputScale: 0.70, jpegQuality: 45 }
]
```

`pickProfile(zoom)`: top-down, first `zoom >= minZoom` win. `setProfile`: update scaleFactor + quality, clear `lastTileChecksums` → resend all. Canvas dims giữ nguyên (client stretch).

## Focus region

```js
setFocusRect({x,y,w,h}):
  pad = REMOTE_CONFIG.focus.paddingTiles  // 4
  col0 = floor(x/tileSize) - pad
  col1 = floor((x+w)/tileSize) + pad
  // row0/row1 tương tự, clamp grid
  activeTileSet = Set<r * tilesPerRow + c>
```

`null` → full screen. Tile vào set mới (không có ở set cũ) → `lastTileChecksums.delete(idx)` để resend dù không thay đổi pixel. Trigger qua `set-focus` event (kèm zoom).

## Checksum (hexagonal sample)

```js
for row = 0; row < h; row += 4:
  offsetX = ((row >> 2) & 1) * 8   // hexagonal pattern
  for col = offsetX; col < w; col += 16:
    p = buffer[(y+row)*stride + (x+col)*4]
    sum += p[0]; sum ^= p[1]; sum += p[2]<<1; sum ^= p[3]<<2
return sum >>> 0
```

Tile 256×256 chỉ chạm ~256 pixel.

## DPI detection

| OS | Strategy |
|---|---|
| darwin | capture buffer → `byteWidth/4` so `getScreenSize().width` → 1.9-2.1 = retina 2x |
| win32 #1 | PowerShell registry `WindowMetrics AppliedDPI` → `dpi/96` |
| win32 #2 | WMI `Win32_VideoController.CurrentHorizontalResolution` → `phys/screen` |
| win32 #3 | Win32 `EnumDisplaySettings` DEVMODE → `dmPelsWidth/screenWidth` |
| linux | 1 |

`captureWidth = floor(screenWidth * dpiScale)`.

## Streaming intervals

```js
streaming = {
  activeInterval: 60,       // ms khi có change
  idleInterval:   400,      // ms khi đứng yên
  idleThreshold:  3,        // 3 frame no-change → idle
  actionCaptureDelay: 50,
  chunkSize: 32,
  chunkDelay: 5
}
```

```
nextInterval = max(0, base - (now - frameStart))
```

User action → `idleFrameCount=0` → active.

## Resource cleanup

| Key | Default | Mục đích |
|---|---|---|
| inactiveTimeout | 2 phút | Client không tương tác |
| memoryCheckInterval | 1 phút | Poll heap |
| memoryWarningThreshold | 1000 MB | Trigger cleanup |
| maxTimersPerClient | 100 | Soft cap |
| maxChunkTimersPerClient | 50 | Soft cap |

## Files

```
agent/features/remote/
  REMOTE_CONFIG.js              ← single source of truth
  TileManager.js                ← capture+tile+checksum+encode (~625 LOC)
  ResourceManager.js            ← per-client lifecycle + memory
  remoteSocket.js               ← setup handlers + grace period
  handlers/
    ScreenHandler.js            ← request-screen, set-focus, streaming loop, encodeTilesBatch
    MouseHandler.js             ← mouse events → robotjs
    KeyboardHandler.js          ← key/typeText → robotjs
  adapters/
    captureAdapter.js           ← robotjs ↔ nodeScreenshots facade
    encoderAdapter.js           ← sharp ↔ jpegTurbo facade
  utils/
    ScreenUpdateHelper.js       ← DPI + screen size + buffer cache

web/features/remote/
  workers/tileDecoder.worker.js ← parse header + createImageBitmap
  hooks/useTiles.js             ← rAF queue + drawImage
  components/                   ← UI
```

## Mở rộng

- **Encoder mới**: thêm case trong `encoderAdapter` + `PLATFORM_DEFAULTS.encoder`.
- **Capture mới**: thêm case trong `captureAdapter` + `PLATFORM_DEFAULTS.capture`.
- **Quality profile**: edit `qualityProfiles` array.
- **Tile size**: đổi `PLATFORM_DEFAULTS.tileSize` (ảnh hưởng grid + memory).
