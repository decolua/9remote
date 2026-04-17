# 🏆 Benchmark Result - 9remote Screen Streaming

> Tổng hợp benchmark trên **macOS ARM (M2)** và **Windows Intel (i5-1135G7)** → chốt libs + giải pháp.

---

## 1. 📚 Libraries CHỐT

| Mục đích | macOS | Windows |
|----------|-------|---------|
| **Capture màn hình** | `@hurdlegroup/robotjs` (60ms) 🏆 | `node-screenshots` (96ms, DXGI GPU) 🏆 |
| **Encode JPEG** | `@julusian/jpeg-turbo` q50 (8ms) 🏆 | `sharp` JPEG q50 (36ms) 🏆 |
| **Mouse/Keyboard control** | `@hurdlegroup/robotjs` | `@hurdlegroup/robotjs` |
| **Tile size** | 128px | 256px |

**Lý do:**
- Mac: `robotjs raw` nhanh hơn `node-screenshots` (60.7ms vs 65.7ms). `jpeg-turbo` nhanh hơn `sharp` 3x (SIMD NEON).
- Win: `robotjs` build lỗi + chỉ capture logical res → loại. `node-screenshots` dùng DXGI GPU. `sharp` nhanh hơn `jpeg-turbo` trên Intel.

---

## 2. 🔄 Flow xử lý frame

```
┌─────────────────┐   ┌──────────────────┐   ┌──────────────┐   ┌──────────────┐
│  Capture BGRA   │──▶│  Tile change-det │──▶│  Encode JPEG │──▶│ DataChannel  │
│  (robotjs/NS)   │   │  (TileManager)   │   │  (turbo/sharp)│  │  (WebRTC)    │
└─────────────────┘   └──────────────────┘   └──────────────┘   └──────────────┘
   Mac: 60ms               ~2ms                 Mac: 8ms
   Win: 96ms                                    Win: 36ms
```

**Chỉ encode các tile thay đổi** (change-detection đã có sẵn trong `TileManager.js`).

---

## 3. 📊 Expected Performance

| OS | Capture | Encode (20% tiles active) | Total | FPS |
|----|:---:|:---:|:---:|:---:|
| **macOS M2** | 60ms | ~3ms | **~63ms** | **~16 FPS** |
| **Windows Intel** | 96ms | ~12ms | **~108ms** | **~9 FPS** |

---

## 4. ✅ CHECKLIST APPLY VÀO CODE

### Phase 1: Config & Dependencies
- [ ] Thêm config per-OS vào `agent/features/remote/REMOTE_CONFIG.js`:
  - [ ] `CAPTURE_LIB` = `"robotjs"` (Mac) / `"node-screenshots"` (Win)
  - [ ] `JPEG_ENCODER` = `"jpegTurbo"` (Mac) / `"sharp"` (Win)
  - [ ] `TILE_SIZE` = 128 (Mac) / 256 (Win)
  - [ ] `JPEG_QUALITY` = 50
- [ ] Cài deps vào `agent/package.json`:
  - [ ] `node-screenshots` (dependency)
  - [ ] `@julusian/jpeg-turbo` (dependency)
  - [ ] `@hurdlegroup/robotjs` giữ nguyên (optionalDependency)
  - [ ] `sharp` giữ nguyên

### Phase 2: Refactor TileManager
- [ ] Tạo module `captureAdapter.js` — switch capture theo `CAPTURE_LIB`:
  - [ ] `robotjs.screen.capture()` → BGRA raw
  - [ ] `node-screenshots.captureImageSync()` → RGBA raw
- [ ] Tạo module `encoderAdapter.js` — switch encoder theo `JPEG_ENCODER`:
  - [ ] `sharp(raw).jpeg({ quality })` 
  - [ ] `jpegTurbo.compressSync(raw, { format, quality })`
- [ ] Update `TileManager.js`:
  - [ ] Dùng `captureAdapter` thay vì hardcode `robotjs`
  - [ ] Dùng `encoderAdapter` thay vì hardcode `sharp`
  - [ ] Bỏ bước BGRA→RGBA conversion (jpeg-turbo nhận BGRA trực tiếp)
  - [ ] Dùng `TILE_SIZE` từ config

### Phase 3: Input handler (không đổi)
- [ ] Verify `robotjs` vẫn dùng cho mouse/keyboard trên cả 2 OS (không thay đổi).

### Phase 4: Verify
- [ ] Build agent trên Mac → test streaming
- [ ] Build agent trên Win → test streaming
- [ ] Compare FPS trước/sau optimize

---

## 5. ❌ Không làm (overkill / chưa khả thi)

- ❌ WGC (Windows Graphics Capture) — chưa có Node binding stable
- ❌ H.264 NVENC/QSV — cần refactor lớn từ JPEG tile → video stream
- ❌ Capture + CPU resize — chậm hơn capture full + tile encode (~15-25ms overhead)
- ❌ `robotjs` cho capture trên Win — build lỗi + chỉ logical res
- ❌ WebP encode — chậm gấp 10x JPEG (261ms vs 23ms trên Mac)

---

**Test env:** macOS MacBook Pro M2 16GB | Windows Intel i5-1135G7 8GB Iris Xe  
**Raw data:** `results/darwin-arm64/latest.md` | `results/win32-x64/latest.md`
