# OpenClaw Chat — Integration Guide

## Protocol Overview

OpenClaw Gateway dùng **WebSocket + JSON frames**. Tất cả giao tiếp đều qua một WebSocket connection duy nhất.

### Frame types

```
Client → Server (request)
{ "type": "req", "id": "<uuid>", "method": "<method>", "params": {...} }

Server → Client (response ngay)
{ "type": "res", "id": "<uuid>", "ok": true, "payload": {...} }
{ "type": "res", "id": "<uuid>", "ok": false, "error": { "code": "...", "message": "..." } }

Server → Client (first message sau khi connect)
{ "type": "hello-ok", "protocol": 3, "server": { "version": "...", "connId": "..." }, "features": {...} }

Server → Client (streaming events)
{ "type": "event", "event": "chat", "payload": { "runId": "...", "sessionKey": "...", "seq": 0, "state": "delta"|"final"|"aborted"|"error", "message": {...} } }
```

---

## Step 1: Connect Handshake

Gửi ngay sau khi WebSocket `open`:

```json
{
  "type": "req",
  "id": "any-uuid",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "my-app",
      "version": "1.0.0",
      "platform": "node",
      "mode": "operator"
    },
    "auth": {
      "token": "<gateway-token>"
    }
  }
}
```

Server trả `hello-ok` — sau đó mới được gọi các method khác.

**Lấy token:**
```bash
openclaw config get gateway.auth.token
# hoặc: cat ~/.openclaw/openclaw.json
```

---

## Step 2: Gửi message (chat.send)

```json
{
  "type": "req",
  "id": "req-uuid",
  "method": "chat.send",
  "params": {
    "sessionKey": "main",
    "message": "Hello!",
    "idempotencyKey": "unique-uuid"
  }
}
```

**Params đầy đủ:**

| Field | Type | Required | Mô tả |
|---|---|---|---|
| `sessionKey` | string | ✅ | `"main"`, `"direct:discord:123"`, v.v. |
| `message` | string | ✅ | Nội dung tin nhắn |
| `idempotencyKey` | string | ✅ | UUID duy nhất mỗi lần gửi |
| `deliver` | boolean | ❌ | Gửi response ra channel ngoài (WhatsApp, Telegram...) |
| `thinking` | string | ❌ | Override thinking level |
| `attachments` | array | ❌ | File/image đính kèm |
| `timeoutMs` | number | ❌ | Timeout cho run |

**Response ngay lập tức:**
```json
{ "type": "res", "id": "req-uuid", "ok": true, "payload": { "runId": "...", "status": "accepted" } }
```

---

## Step 3: Nhận streaming response (chat events)

Sau khi `chat.send` accepted, server push các events:

### Delta event (text streaming)
```json
{
  "type": "event",
  "event": "chat",
  "payload": {
    "runId": "run-uuid",
    "sessionKey": "main",
    "seq": 1,
    "state": "delta",
    "message": { "text": "Hello! How can I..." }
  }
}
```

> ⚠️ **`message.text` là cumulative** — server gửi toàn bộ text từ đầu, không phải từng chunk riêng lẻ.

### Final event (hoàn thành)
```json
{
  "type": "event",
  "event": "chat",
  "payload": {
    "runId": "run-uuid",
    "sessionKey": "main",
    "seq": 5,
    "state": "final",
    "message": { "text": "Hello! How can I help you today?" },
    "usage": { ... },
    "stopReason": "end_turn"
  }
}
```

### Error / Aborted
```json
{ "state": "error", "errorMessage": "..." }
{ "state": "aborted" }
```

---

## Step 4: Hủy run đang chạy (chat.abort)

```json
{
  "type": "req",
  "id": "req-uuid",
  "method": "chat.abort",
  "params": {
    "sessionKey": "main",
    "runId": "run-uuid"
  }
}
```

---

## Step 5: Lấy lịch sử (chat.history)

```json
{
  "type": "req",
  "id": "req-uuid",
  "method": "chat.history",
  "params": {
    "sessionKey": "main",
    "limit": 50
  }
}
```

---

## Full Example — Node.js

```js
import { WebSocket } from "ws";
import { randomUUID } from "crypto";

const GATEWAY_URL = "ws://127.0.0.1:18789";
const GATEWAY_TOKEN = "your-token-here";
const PROTOCOL_VERSION = 3;

class OpenClawClient {
  #ws = null;
  #pending = new Map();
  #listeners = new Map();

  connect() {
    return new Promise((resolve, reject) => {
      this.#ws = new WebSocket(GATEWAY_URL);

      this.#ws.on("open", () => {
        this.#send({
          type: "req",
          id: randomUUID(),
          method: "connect",
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: { id: "my-app", version: "1.0.0", platform: "node", mode: "operator" },
            auth: { token: GATEWAY_TOKEN },
          },
        });
      });

      this.#ws.on("message", (raw) => this.#onFrame(JSON.parse(raw.toString())));
      this.#ws.on("error", reject);

      this.once("hello-ok", () => resolve(this));
    });
  }

  // Chat và nhận streaming
  chat(sessionKey, message, onDelta) {
    return new Promise((resolve, reject) => {
      const idempotencyKey = randomUUID();
      let fullText = "";

      const handler = (payload) => {
        if (payload.state === "delta") {
          fullText = payload.message?.text ?? fullText;
          onDelta?.(fullText);
        } else if (payload.state === "final") {
          this.off("chat", handler);
          resolve({ text: fullText, runId: payload.runId });
        } else if (payload.state === "error") {
          this.off("chat", handler);
          reject(new Error(payload.errorMessage ?? "chat error"));
        } else if (payload.state === "aborted") {
          this.off("chat", handler);
          reject(new Error("aborted"));
        }
      };

      this.on("chat", handler);

      this.#request(randomUUID(), "chat.send", {
        sessionKey,
        message,
        idempotencyKey,
      }).catch(reject);
    });
  }

  abort(sessionKey, runId) {
    return this.#request(randomUUID(), "chat.abort", { sessionKey, runId });
  }

  history(sessionKey, limit = 50) {
    return this.#request(randomUUID(), "chat.history", { sessionKey, limit });
  }

  #send(frame) { this.#ws.send(JSON.stringify(frame)); }

  #request(id, method, params) {
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#send({ type: "req", id, method, params });
    });
  }

  #onFrame(frame) {
    if (frame.type === "hello-ok") {
      this.#emit("hello-ok", frame);
    } else if (frame.type === "res") {
      const p = this.#pending.get(frame.id);
      if (p) {
        this.#pending.delete(frame.id);
        frame.ok ? p.resolve(frame.payload) : p.reject(new Error(frame.error?.message));
      }
    } else if (frame.type === "event") {
      this.#emit(frame.event, frame.payload);
    }
  }

  on(event, fn) { (this.#listeners.get(event) ?? this.#listeners.set(event, new Set()).get(event)).add(fn); }
  once(event, fn) { const w = (...a) => { this.off(event, w); fn(...a); }; this.on(event, w); }
  off(event, fn) { this.#listeners.get(event)?.delete(fn); }
  #emit(event, payload) { this.#listeners.get(event)?.forEach((fn) => fn(payload)); }

  close() { this.#ws?.close(); }
}

// ===== Usage =====
const client = new OpenClawClient();
await client.connect();

const result = await client.chat(
  "main",
  "Explain quantum computing in one sentence",
  (text) => process.stdout.write("\r" + text)
);

console.log("\nDone:", result.text);
client.close();
```

---

## Config Methods

Đọc/ghi config qua WebSocket:

```js
// Đọc config
const config = await client.#request(randomUUID(), "config.get", { path: "gateway.auth" });

// Ghi config
await client.#request(randomUUID(), "config.set", { path: "agents.defaults.model", value: "gpt-4o" });

// Patch nhiều fields
await client.#request(randomUUID(), "config.patch", { patch: { "agents.defaults.thinking": "low" } });
```

---

## Session Keys

| Key | Mô tả |
|---|---|
| `"main"` | Session chính (default) |
| `"direct:discord:<channel-id>"` | Discord channel cụ thể |
| `"direct:telegram:<chat-id>"` | Telegram chat cụ thể |
| `"direct:whatsapp:<phone>"` | WhatsApp số điện thoại |

---

## Lưu ý

- `idempotencyKey` là **bắt buộc** — luôn dùng `randomUUID()` mỗi lần gửi mới
- Phải nhận `hello-ok` trước khi gọi bất kỳ method nào
- `chat` event `message.text` là **cumulative** (tích lũy từ đầu, không phải delta)
- Default port: `18789`, URL: `ws://127.0.0.1:18789`
- `PROTOCOL_VERSION = 3` (bắt buộc đúng)
