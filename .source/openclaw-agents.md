# OpenClaw Multi-Agent — Integration Guide

## Khái niệm cơ bản

OpenClaw hỗ trợ nhiều agent chạy song song, mỗi agent có:
- **agentId** riêng (default: `"main"`)
- **workspace** riêng (`~/.openclaw/workspace-<agentId>/`)
- **sessions** riêng (mỗi agent có nhiều session)
- **model** riêng (có thể config khác nhau)
- **identity** riêng (tên, avatar, emoji)

### Session Key format

```
agent:<agentId>:<sessionName>
```

Ví dụ:
- `agent:main:main` — session chính của agent main
- `agent:coder:main` — session chính của agent "coder"
- `agent:main:direct:discord:123456` — session Discord của agent main

Shorthand: `"main"` ≡ `"agent:main:main"` (gateway tự resolve)

---

## Agent Methods (WebSocket)

### 1. Liệt kê agents

```json
{
  "type": "req",
  "id": "uuid",
  "method": "agents.list",
  "params": {}
}
```

Response:
```json
{
  "ok": true,
  "payload": {
    "defaultId": "main",
    "mainKey": "agent:main:main",
    "scope": "global",
    "agents": [
      {
        "id": "main",
        "name": "OpenClaw",
        "identity": { "name": "OpenClaw", "emoji": "🦞", "avatar": "...", "avatarUrl": "..." },
        "workspace": "/Users/you/.openclaw/workspace",
        "model": { "primary": "claude-opus-4-5", "fallbacks": [] }
      }
    ]
  }
}
```

`scope`:
- `"global"` — tất cả users dùng chung agent
- `"per-sender"` — mỗi user/channel có agent riêng

---

### 2. Tạo agent mới

```json
{
  "type": "req",
  "id": "uuid",
  "method": "agents.create",
  "params": {
    "name": "Coder",
    "workspace": "/path/to/workspace",
    "emoji": "💻",
    "avatar": "https://..."
  }
}
```

Response:
```json
{
  "ok": true,
  "payload": {
    "ok": true,
    "agentId": "coder",
    "name": "Coder",
    "workspace": "/path/to/workspace"
  }
}
```

---

### 3. Cập nhật agent

```json
{
  "type": "req",
  "id": "uuid",
  "method": "agents.update",
  "params": {
    "agentId": "coder",
    "name": "Senior Coder",
    "model": "anthropic/claude-opus-4-5",
    "avatar": "https://..."
  }
}
```

---

### 4. Xóa agent

```json
{
  "type": "req",
  "id": "uuid",
  "method": "agents.delete",
  "params": {
    "agentId": "coder",
    "deleteFiles": false
  }
}
```

---

### 5. Lấy identity của agent

```json
{
  "type": "req",
  "id": "uuid",
  "method": "agent.identity.get",
  "params": {
    "agentId": "coder"
  }
}
```

Response:
```json
{
  "ok": true,
  "payload": {
    "agentId": "coder",
    "name": "Coder",
    "avatar": "https://...",
    "emoji": "💻"
  }
}
```

---

## Chat với agent cụ thể

### Dùng `chat.send` với sessionKey của agent đó

```json
{
  "type": "req",
  "id": "uuid",
  "method": "chat.send",
  "params": {
    "sessionKey": "agent:coder:main",
    "message": "Review this code...",
    "idempotencyKey": "unique-uuid"
  }
}
```

### Dùng `agent` method (full LLM run) với agentId

```json
{
  "type": "req",
  "id": "uuid",
  "method": "agent",
  "params": {
    "message": "Write a Python script",
    "agentId": "coder",
    "model": "anthropic/claude-opus-4-5",
    "thinking": "high",
    "deliver": false,
    "idempotencyKey": "unique-uuid"
  }
}
```

**`agent` params đầy đủ:**

| Field | Type | Required | Mô tả |
|---|---|---|---|
| `message` | string | ✅ | Tin nhắn |
| `agentId` | string | ❌ | Agent cụ thể (default: `"main"`) |
| `sessionKey` | string | ❌ | Session key cụ thể |
| `model` | string | ❌ | Override model (`"anthropic/claude-opus-4-5"`) |
| `provider` | string | ❌ | Override provider |
| `thinking` | string | ❌ | `"low"` \| `"medium"` \| `"high"` |
| `deliver` | boolean | ❌ | Gửi response ra channel ngoài |
| `timeout` | number | ❌ | Timeout ms |
| `lane` | string | ❌ | Execution lane |
| `extraSystemPrompt` | string | ❌ | Thêm vào system prompt |
| `idempotencyKey` | string | ✅ | UUID duy nhất |

---

### Chờ agent hoàn thành (`agent.wait`)

`agent` method trả về `runId` ngay lập tức. Dùng `agent.wait` để poll kết quả:

```json
{
  "type": "req",
  "id": "uuid",
  "method": "agent.wait",
  "params": {
    "runId": "run-uuid-here",
    "timeoutMs": 30000
  }
}
```

Response (khi xong):
```json
{
  "ok": true,
  "payload": {
    "status": "completed",
    "output": "...",
    "runId": "run-uuid"
  }
}
```

---

## Subagent (Agent spawn Agent)

OpenClaw hỗ trợ agent spawn subagent để chạy tasks song song. Đây là cơ chế **nội bộ** — agent tự gọi qua tool `sessions_spawn`.

### Cơ chế hoạt động

```
Agent "main"
  └── spawn subagent → agent:main:sub-<uuid>  (mode: "run")
  └── spawn thread   → agent:main:thread-<uuid> (mode: "session")
```

- **mode `"run"`** — subagent chạy 1 task rồi kết thúc, báo cáo kết quả về parent
- **mode `"session"`** — subagent tạo session tồn tại lâu dài (thread)

### Spawn depth limit

Mặc định max depth = 5 (cấu hình được qua `agents.defaults.subagents.maxSpawnDepth`):

```
main (depth 0)
  └── sub1 (depth 1)
        └── sub2 (depth 2)
              └── sub3 (depth 3) ... tối đa
```

### Theo dõi subagents

Dùng `sessions.list` với filter `spawnedBy`:

```json
{
  "type": "req",
  "id": "uuid",
  "method": "sessions.list",
  "params": {
    "agentId": "main",
    "spawnedBy": "agent:main:main",
    "includeLastMessage": true
  }
}
```

---

## Session Management (Multi-Agent)

### Liệt kê sessions của agent

```json
{
  "type": "req",
  "id": "uuid",
  "method": "sessions.list",
  "params": {
    "agentId": "coder",
    "limit": 20,
    "includeDerivedTitles": true,
    "includeLastMessage": true
  }
}
```

### Tạo session mới cho agent

```json
{
  "type": "req",
  "id": "uuid",
  "method": "sessions.create",
  "params": {
    "agentId": "coder",
    "key": "my-project-review",
    "label": "Project Review",
    "model": "anthropic/claude-opus-4-5",
    "task": "Review the codebase"
  }
}
```

### Gửi message vào session (không qua LLM)

```json
{
  "type": "req",
  "id": "uuid",
  "method": "sessions.send",
  "params": {
    "key": "agent:coder:my-project-review",
    "message": "Start the review",
    "thinking": "high",
    "idempotencyKey": "uuid"
  }
}
```

### Subscribe nhận events từ session

```json
{
  "type": "req",
  "id": "uuid",
  "method": "sessions.messages.subscribe",
  "params": {
    "key": "agent:coder:my-project-review"
  }
}
```

Server sẽ push event `session.message` mỗi khi có tin nhắn mới trong session đó.

---

## Agent Workspace Files

Mỗi agent có workspace files cấu hình persona/behavior:

| File | Mô tả |
|---|---|
| `AGENTS.md` | Danh sách subagents và capabilities |
| `SOUL.md` | Personality, values, tone |
| `IDENTITY.md` | Tên, vai trò, avatar |
| `USER.md` | Thông tin về user |
| `TOOLS.md` | Tools policy |
| `HEARTBEAT.md` | Heartbeat/proactive behavior |
| `BOOTSTRAP.md` | Bootstrap context |
| `MEMORY.md` | Long-term memory |

### Đọc workspace file

```json
{
  "type": "req",
  "id": "uuid",
  "method": "agents.files.get",
  "params": {
    "agentId": "coder",
    "name": "SOUL.md"
  }
}
```

### Ghi workspace file

```json
{
  "type": "req",
  "id": "uuid",
  "method": "agents.files.set",
  "params": {
    "agentId": "coder",
    "name": "SOUL.md",
    "content": "You are a senior software engineer..."
  }
}
```

### Liệt kê workspace files

```json
{
  "type": "req",
  "id": "uuid",
  "method": "agents.files.list",
  "params": {
    "agentId": "coder"
  }
}
```

---

## Config cho Multi-Agent

Trong `~/.openclaw/openclaw.json`:

```json5
{
  "agents": {
    "defaults": {
      "model": { "primary": "anthropic/claude-opus-4-5" },
      "thinking": "medium",
      "subagents": {
        "maxSpawnDepth": 5
      }
    },
    "list": [
      {
        "id": "main",
        "name": "OpenClaw",
        "workspace": "~/.openclaw/workspace",
        "model": { "primary": "anthropic/claude-opus-4-5" },
        "thinkingDefault": "medium"
      },
      {
        "id": "coder",
        "name": "Coder",
        "workspace": "~/projects/my-app",
        "model": { "primary": "anthropic/claude-opus-4-5" },
        "thinkingDefault": "high"
      }
    ]
  }
}
```

Config via WebSocket:
```js
// Thêm agent mới vào config
await request("config.patch", {
  patch: {
    "agents.list": [
      ...existingAgents,
      { id: "researcher", name: "Researcher", workspace: "~/.openclaw/workspace-researcher" }
    ]
  }
});
```

---

## Node.js Example — Chat với nhiều agents song song

```js
import { OpenClawClient } from "./openclaw-client.js"; // từ openclaw-chat.md
import { randomUUID } from "crypto";

const client = new OpenClawClient();
await client.connect();

// Liệt kê agents
const { agents } = await client.request("agents.list", {});
console.log("Agents:", agents.map(a => `${a.id}: ${a.name}`));

// Chat với 2 agents song song
const [result1, result2] = await Promise.all([
  client.chat("agent:main:main", "Summarize quantum computing"),
  client.chat("agent:coder:main", "Write hello world in Rust"),
]);

console.log("main:", result1.text);
console.log("coder:", result2.text);

// Tạo agent mới
const created = await client.request("agents.create", {
  name: "Researcher",
  workspace: "/Users/you/.openclaw/workspace-researcher",
  emoji: "🔬",
});
console.log("Created agent:", created.agentId);

// Chat với agent vừa tạo (qua `agent` method để control model)
const reqId = randomUUID();
const accepted = await client.request("agent", {
  message: "Research the history of AI",
  agentId: created.agentId,
  thinking: "high",
  idempotencyKey: randomUUID(),
});

// Poll cho xong
const done = await client.request("agent.wait", {
  runId: accepted.runId,
  timeoutMs: 60_000,
});
console.log("Research result:", done.output);

client.close();
```

---

## Lưu ý quan trọng

| Điểm | Chi tiết |
|---|---|
| **Default agentId** | `"main"` — luôn tồn tại |
| **Session key** | Format `agent:<id>:<name>` hoặc shorthand `"main"` |
| **Subagent là nội bộ** | Agent tự spawn qua tool, không thể spawn từ middleware trực tiếp |
| **Spawn depth** | Max 5 cấp (config được) |
| **`agent` vs `chat.send`** | `agent` = full LLM run với routing + delivery; `chat.send` = WebChat session |
| **Workspace files** | Đọc/ghi qua `agents.files.*` methods |
| **agents.list scope** | `"global"` hoặc `"per-sender"` (per-sender = mỗi user có agent riêng) |
