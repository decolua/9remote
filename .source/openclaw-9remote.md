# Tích hợp OpenClaw vào 9remote

## Kiến trúc tổng quan

```
Browser (web/app/workspace)
  └── Socket.IO ──→ Agent Server (agent/index.js :2208)
                        └── WebSocket ──→ OpenClaw Gateway (:18789)
```

**Agent** = trung gian Node.js kết nối OpenClaw  
**Web** = UI chat hiển thị response

---

## Phần 1 — Agent (Node.js backend)

### Thêm OpenClaw client vào Agent Server

Tạo file `agent/features/openclaw/client.js`:

```js
import { WebSocket } from "ws";
import { randomUUID } from "crypto";

const GATEWAY_URL = process.env.OPENCLAW_URL ?? "ws://127.0.0.1:18789";
const GATEWAY_TOKEN = process.env.OPENCLAW_TOKEN ?? "";
const PROTOCOL_VERSION = 3;

class OpenClawClient {
  #ws = null;
  #pending = new Map();
  #listeners = new Map();
  #ready = false;

  connect() {
    return new Promise((resolve, reject) => {
      this.#ws = new WebSocket(GATEWAY_URL);

      this.#ws.on("open", () => {
        this.#send({
          type: "req", id: randomUUID(), method: "connect",
          params: {
            minProtocol: PROTOCOL_VERSION, maxProtocol: PROTOCOL_VERSION,
            client: { id: "9remote-agent", version: "1.0.0", platform: "node", mode: "operator" },
            auth: { token: GATEWAY_TOKEN },
          },
        });
      });

      this.#ws.on("message", (raw) => this.#onFrame(JSON.parse(raw.toString())));
      this.#ws.on("error", (err) => { if (!this.#ready) reject(err); });
      this.#ws.on("close", () => { this.#ready = false; this.#emit("close", {}); });

      this.once("hello-ok", () => { this.#ready = true; resolve(this); });
    });
  }

  // Chat với streaming — gọi onDelta(text) mỗi lần có text mới
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
      this.#request(randomUUID(), "chat.send", { sessionKey, message, idempotencyKey }).catch(reject);
    });
  }

  abort(sessionKey) {
    return this.#request(randomUUID(), "chat.abort", { sessionKey });
  }

  request(method, params) {
    return this.#request(randomUUID(), method, params);
  }

  get isReady() { return this.#ready; }

  #send(frame) { this.#ws?.send(JSON.stringify(frame)); }

  #request(id, method, params) {
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#send({ type: "req", id, method, params });
    });
  }

  #onFrame(frame) {
    if (frame.type === "hello-ok") this.#emit("hello-ok", frame);
    else if (frame.type === "res") {
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
}

// Singleton — dùng chung toàn app
let instance = null;

export async function getOpenClawClient() {
  if (instance?.isReady) return instance;
  instance = new OpenClawClient();
  await instance.connect();
  return instance;
}
```

---

### Thêm Socket.IO events vào Agent Server

Trong `agent/lib/socketio.js`, thêm namespace chat:

```js
import { getOpenClawClient } from "../features/openclaw/client.js";

// Trong setupSocketIO(), sau các setup hiện tại:
setupOpenClawSocket(io);

function setupOpenClawSocket(io) {
  const ns = io.of("/openclaw");

  ns.on("connection", (socket) => {

    // Client gửi message → stream delta về
    socket.on("chat:send", async ({ sessionKey = "main", message }) => {
      try {
        const client = await getOpenClawClient();

        await client.chat(sessionKey, message, (deltaText) => {
          socket.emit("chat:delta", { sessionKey, text: deltaText });
        });

        socket.emit("chat:done", { sessionKey });
      } catch (err) {
        socket.emit("chat:error", { message: err.message });
      }
    });

    // Client muốn hủy run đang chạy
    socket.on("chat:abort", async ({ sessionKey = "main" }) => {
      try {
        const client = await getOpenClawClient();
        await client.abort(sessionKey);
      } catch { /* ignore */ }
    });

    // Client lấy lịch sử
    socket.on("chat:history", async ({ sessionKey = "main", limit = 50 }) => {
      try {
        const client = await getOpenClawClient();
        const result = await client.request("chat.history", { sessionKey, limit });
        socket.emit("chat:history:result", result);
      } catch (err) {
        socket.emit("chat:error", { message: err.message });
      }
    });

    // Client lấy danh sách agents
    socket.on("agents:list", async () => {
      try {
        const client = await getOpenClawClient();
        const result = await client.request("agents.list", {});
        socket.emit("agents:list:result", result);
      } catch (err) {
        socket.emit("chat:error", { message: err.message });
      }
    });

  });
}
```

---

## Phần 2 — Web (Next.js client)

### Hook kết nối tới namespace `/openclaw`

Tạo `web/shared/hooks/useOpenClaw.js`:

```js
"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { io } from "socket.io-client";

export function useOpenClaw({ tunnelUrl, apiKey, sessionKey = "main" }) {
  const socketRef = useRef(null);
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!tunnelUrl) return;

    const socket = io(`${tunnelUrl}/openclaw`, {
      auth: { apiKey },
      transports: ["websocket"],
    });

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));

    // Nhận delta từ stream → update tin nhắn đang gõ
    socket.on("chat:delta", ({ text }) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          return [...prev.slice(0, -1), { ...last, text }];
        }
        return [...prev, { role: "assistant", text, streaming: true }];
      });
    });

    // Stream xong → đánh dấu final
    socket.on("chat:done", () => {
      setStreaming(false);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.streaming) return [...prev.slice(0, -1), { ...last, streaming: false }];
        return prev;
      });
    });

    socket.on("chat:error", ({ message }) => {
      setStreaming(false);
      setMessages((prev) => [...prev, { role: "error", text: message }]);
    });

    // Nhận history khi load
    socket.on("chat:history:result", ({ messages: hist }) => {
      if (hist?.length) setMessages(hist.map((m) => ({ role: m.role, text: m.content ?? m.text })));
    });

    socketRef.current = socket;
    socket.emit("chat:history", { sessionKey });

    return () => socket.disconnect();
  }, [tunnelUrl, apiKey, sessionKey]);

  const sendMessage = useCallback((text) => {
    if (!socketRef.current || streaming) return;
    setStreaming(true);
    setMessages((prev) => [...prev, { role: "user", text }]);
    socketRef.current.emit("chat:send", { sessionKey, message: text });
  }, [sessionKey, streaming]);

  const abortMessage = useCallback(() => {
    socketRef.current?.emit("chat:abort", { sessionKey });
    setStreaming(false);
  }, [sessionKey]);

  return { messages, streaming, connected, sendMessage, abortMessage };
}
```

---

### UI Chat Component

Tạo `web/shared/components/OpenClawChat.js`:

```jsx
"use client";
import { useState } from "react";
import { useOpenClaw } from "@/shared/hooks/useOpenClaw";

export function OpenClawChat({ tunnelUrl, apiKey }) {
  const [input, setInput] = useState("");
  const { messages, streaming, connected, sendMessage, abortMessage } = useOpenClaw({
    tunnelUrl, apiKey, sessionKey: "main",
  });

  const onSubmit = (e) => {
    e.preventDefault();
    if (!input.trim()) return;
    sendMessage(input.trim());
    setInput("");
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 p-3 border-b">
        <span className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-red-400"}`} />
        <span className="text-sm font-medium">OpenClaw</span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap
              ${msg.role === "user" ? "bg-blue-500 text-white" : "bg-gray-100 text-gray-900"}
              ${msg.streaming ? "opacity-80" : ""}`}>
              {msg.text}
              {msg.streaming && <span className="ml-1 animate-pulse">▋</span>}
            </div>
          </div>
        ))}
      </div>

      {/* Input */}
      <form onSubmit={onSubmit} className="p-3 border-t flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message OpenClaw..."
          disabled={!connected}
          className="flex-1 rounded-lg border px-3 py-2 text-sm focus:outline-none"
        />
        {streaming
          ? <button type="button" onClick={abortMessage} className="px-3 py-2 rounded-lg bg-red-500 text-white text-sm">Stop</button>
          : <button type="submit" disabled={!connected || !input.trim()} className="px-3 py-2 rounded-lg bg-blue-500 text-white text-sm disabled:opacity-40">Send</button>
        }
      </form>
    </div>
  );
}
```

---

### Nhúng vào Workspace

Trong `web/app/workspace/page.js`, thêm:

```jsx
import { OpenClawChat } from "@/shared/components/OpenClawChat";

// Trong layout workspace, thêm panel chat:
<OpenClawChat tunnelUrl={tunnelUrl} apiKey={apiKey} />
```

---

## Biến môi trường

```bash
# agent/.env
OPENCLAW_URL=ws://127.0.0.1:18789
OPENCLAW_TOKEN=<token từ ~/.openclaw/openclaw.json>
```

Lấy token:
```bash
openclaw config get gateway.auth.token
```

---

## Flow hoàn chỉnh

```
User gõ message (web UI)
  → socket.emit("chat:send", { sessionKey, message })    [Socket.IO /openclaw]
  → Agent nhận, gọi OpenClawClient.chat()
  → Agent WebSocket → openclaw gateway → LLM
  → Gateway stream "chat" events về Agent
  → Agent emit socket.emit("chat:delta", { text })       [mỗi delta]
  → Web nhận, update message đang stream
  → Gateway emit state "final"
  → Agent emit socket.emit("chat:done")
  → Web đánh dấu message hoàn thành
```

---

## Tóm tắt files cần tạo/sửa

| File | Việc cần làm |
|---|---|
| `agent/features/openclaw/client.js` | **Tạo mới** — OpenClaw WebSocket client |
| `agent/lib/socketio.js` | **Sửa** — thêm `setupOpenClawSocket(io)` |
| `web/shared/hooks/useOpenClaw.js` | **Tạo mới** — React hook |
| `web/shared/components/OpenClawChat.js` | **Tạo mới** — Chat UI component |
| `web/app/workspace/page.js` | **Sửa** — nhúng `<OpenClawChat>` vào workspace |
| `agent/.env` | **Tạo/sửa** — thêm `OPENCLAW_URL` + `OPENCLAW_TOKEN` |
