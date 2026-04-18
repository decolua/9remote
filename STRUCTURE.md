# Desktop (/desktop)

Tauri app — khi mở, tự spawn Agent local rồi load UI từ localhost.

``` 
User opens Desktop (Tauri)
 ├─ [first run] npm install -g 9remote
 ├─ spawn: npm exec -- 9remote ui   → Agent server :2208
 ├─ poll :2208/api/health  →  emit setup_ready khi sẵn sàng
 └─ WebView load http://localhost:2208
     └─ same flow as /web below
```

> Dev mode: WebView load Vite :5173 trực tiếp, không spawn Agent.

---

# Cli + UI + Agent (/agent)

CLI là entrypoint, spawn Agent server, mở tunnel, serve UI tĩnh.

```
User runs: npx 9remote

CLI (index.js)
 ├─ check/update version
 ├─ login → POST /api/session/create  (Worker, lấy machineId)
 ├─ spawn Agent server (node server.cjs) on :2208
 │   ├─ serve UI static (ui/dist/) tại GET /
 │   ├─ Socket.IO namespace /   → terminal + remote events
 │   ├─ GET  /api/health        → health check
 │   ├─ GET  /api/ui/events     → SSE stream trạng thái cho UI
 │   ├─ POST /api/notify        → nhận notification từ AI hooks
 │   └─ GET  /proxy/:port/*     → reverse proxy tới local port
 ├─ spawn cloudflared tunnel  → lấy public URL
 ├─ POST /api/session/update  (Worker, lưu tunnelUrl)
 └─ show QR + URL cho user kết nối

Agent features (Socket.IO):
 ├─ terminal/  → PTY daemon → shell process (persist across reconnect)
 └─ remote/    → robotjs capture screen → tile frames → client
```

---

# Client + Worker (/web)

Next.js app (client UI) + Cloudflare Worker (edge API + DB).

```
Browser / Desktop WebView / Expo WebView
 │
 ├─ /login   → nhập URL + API key
 │            → Worker: GET /api/session/connect  (verify key, trả session info)
 │
 └─ /workspace
     ├─ useSocket → WsProtocol (Socket.IO qua tunnel hoặc LAN)
     │   ├─ LocalFirstAdapter: race LAN vs tunnel, dùng cái nhanh hơn
     │   └─ TunnelAdapter: kết nối trực tiếp qua cloudflared URL
     ├─ WebRtcProtocol (nếu bật)
     │   ├─ Worker: GET /api/turn  → lấy TURN credentials
     │   └─ RTCDataChannel  → nhận binary tile frames từ Agent
     ├─ Terminal   → stream PTY output / gửi input qua Socket.IO
     ├─ RemoteDesktop → nhận tile frames (WS hoặc WebRTC), gửi mouse/keyboard
     └─ FileExplorer  → browse / upload / download qua Socket.IO

Worker (Cloudflare Edge — 9remote.cc)
 ├─ POST /api/session/create   → tạo session (CLI gọi khi start)
 ├─ POST /api/session/update   → lưu tunnelUrl sau khi có tunnel
 ├─ GET  /api/session/connect  → client verify key, lấy tunnelUrl
 ├─ POST /api/tunnel/create    → tạo Cloudflare tunnel qua API
 ├─ GET  /api/turn             → TURN credentials cho WebRTC
 └─ POST /api/temp-key         → tạo one-time key để share session
```

---

# Expo (/expo)

React Native app — shell mỏng, bọc Web UI qua WebView.

```
User opens mobile app
 └─ WebViewContainer  →  load 9remote.com (Web UI)
     ├─ useNetworkStatus  → hiện OfflineBanner khi mất mạng
     ├─ useVersionCheck   → báo update khi có phiên bản mới
     └─ useWebView        → reload / goBack / injectJS
```
