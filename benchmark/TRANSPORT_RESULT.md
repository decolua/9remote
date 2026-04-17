# 🚚 Transport Benchmark - Tile Streaming

> So sánh serialization overhead cho tile streaming (345 tiles, ~516KB JPEG, Mac M2).

---

## 1. 📊 Kết quả benchmark

| Method | Size | Overhead | Encode | Decode | Used by |
|--------|:---:|:---:|:---:|:---:|:---|
| **JSON + base64** | 735.8KB | **+42.5%** 💥 | 0.83ms | 0.70ms | Legacy (không dùng) |
| **socket.io parser** | 572.9KB | +10.9% | 0.19ms | ~0ms | ⚠️ Socket.io fallback hiện tại |
| **Binary pack** 🏆 | 524.6KB | **+1.6%** ✅ | 0.13ms | 0.05ms | ✅ WebRTC DataChannel |

Raw JPEG baseline: 516.5KB (0% overhead).

---

## 2. 🔍 Code hiện tại

### ✅ WebRTC DataChannel path — `ScreenHandler.js`

```js
protocol.sendTiles({ tiles, timestamp }, encodeTilesBatch);
```

- `encodeTilesBatch` → **Binary pack** (12-byte batch header + 24-byte/tile + JPEG)
- Overhead: **+1.6%** ✅ Tối ưu tốt

### ⚠️ Socket.io fallback path — `ScreenUpdateHelper.js`

```js
socket.emit("tiles-data", { tiles: chunk, timestamp, chunkInfo });
```

- socket.io v4 parser tự handle Buffer → binary attachments + JSON metadata
- Overhead: **+10.9%** (~9% tốn băng thông extra)
- Có thể tối ưu xuống **+1.6%** bằng binary emit

---

## 3. 🎯 Đề xuất tối ưu Socket.io path

### Chiến lược
Thay vì emit object `{ tiles: [...] }`, emit **binary Buffer trực tiếp** qua socket.io.

### Trade-off
- ✅ **Tiết kiệm ~9% bandwidth** trên socket.io fallback
- ✅ Encode/decode nhanh hơn socket.io parser
- ⚠️ Mất cấu trúc event dễ đọc (cần tool decode để debug)
- ⚠️ Web client phải có decoder song song (đã có cho WebRTC — reuse được)

### Khi nào cần làm?
- **Không cần** nếu user đa số dùng WebRTC (P2P thường ok)
- **Cần** nếu WebRTC thường fail → socket.io fallback chạy nhiều

---

## 4. ✅ Checklist apply

### Phase 1: Agent-side
- [ ] Thêm handler `socket.emit("tiles-data-binary", buffer)` trong `ScreenUpdateHelper.js`
- [ ] Reuse `encodeTilesBatch()` từ `ScreenHandler.js` (không duplicate code)
- [ ] Flag config `REMOTE_CONFIG.streaming.useBinarySocket` (default: `false` để safe rollback)

### Phase 2: Web-side  
- [ ] Thêm listener `socket.on("tiles-data-binary", buf => decodeTilesBatch(buf))` 
- [ ] Reuse decoder từ WebRTC path (`decodeTilesBatch`)
- [ ] Fallback: nếu client không support → agent dùng event cũ

### Phase 3: Handshake
- [ ] Client gửi capability `{ supportsBinary: true }` lúc connect
- [ ] Agent check flag → chọn emit event nào
- [ ] Auto-fallback nếu handshake fail

### Phase 4: Verify
- [ ] Disable WebRTC → force socket.io
- [ ] Check metrics: `data=KB/frame` giảm ~9%
- [ ] Test cả 2 OS (Mac + Win)

---

## 5. ❌ Không làm (overkill)

- ❌ Chuyển sang protobuf/msgpack custom — `encodeTilesBatch` binary đã đủ nhẹ
- ❌ Compress thêm (gzip/brotli trên JPEG) — JPEG đã compressed, gzip vô tác dụng
- ❌ Custom WebSocket raw (không dùng socket.io) — mất feature reconnect, rooms, auth

---

## 6. 📈 Expected improvement

| Transport | Hiện tại | Sau optimize | Improvement |
|-----------|:---:|:---:|:---:|
| WebRTC DC | 524.6KB/frame | 524.6KB/frame | - (đã tối ưu) |
| Socket.io | 572.9KB/frame | 524.6KB/frame | **-8.5% bandwidth** |

Với frame rate 15 FPS active:
- Hiện tại socket.io: 572.9 × 15 = **8.6 MB/s**
- Sau optimize: 524.6 × 15 = **7.9 MB/s**
- **Tiết kiệm ~0.7 MB/s** khi WebRTC fail

---

**Raw data:** `benchmark/testTransport.js`  
**Baseline code:** `agent/features/remote/handlers/ScreenHandler.js` (binary pack), `agent/features/remote/utils/ScreenUpdateHelper.js` (socket.io)
