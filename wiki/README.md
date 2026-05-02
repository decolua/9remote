# 9remote Wiki

Docs cho AI/dev mới — đọc trước khi code.

## Files

| Doc | Module |
|---|---|
| [transport.md](./transport.md) | WS+RTC adapter, codec, ack, fallback |
| [remoteDesktop.md](./remoteDesktop.md) | Capture → tile → encode → stream |
| [cloud.md](./cloud.md) | Cloudflare Worker (API + D1 + cron) |
| [desktop.md](./desktop.md) | Tauri shell (IPC, tray, spawn) |
| [expo.md](./expo.md) | WebView mobile (push, version cache) |

## Topology

```
Web/Mobile  ◀──ws/rtc──▶  CF Worker (API,D1,cron)  ◀──tunnel──▶  Agent (CLI+PTY+Remote)
```

- Web: Next.js, host `9remote.cc/*` qua Worker.
- Worker: tạo tunnel + cấp TURN, lưu session D1.
- Agent: Node CLI, expose qua CF Named Tunnel.

## Conventions

- camelCase, no TS, DRY, config-driven (`*_CONFIG.js`).
- 1 file = 1 trách nhiệm.
- Constants tập trung, không hardcode.
