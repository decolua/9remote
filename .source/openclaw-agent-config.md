# OpenClaw Agent Config — Cấu hình từng Agent

## Cấu trúc config 1 agent

```json5
// ~/.openclaw/openclaw.json
{
  "agents": {
    "list": [
      { /* AgentConfig */ }
    ]
  }
}
```

---

## Các nhóm cấu hình

### 1. 🪪 Identity — Danh tính

| Field | Type | Mô tả | Ví dụ |
|---|---|---|---|
| `id` | string | ID duy nhất | `"coder"` |
| `name` | string | Tên hiển thị | `"Senior Coder"` |
| `identity.name` | string | Tên trong chat | `"Coda"` |
| `identity.emoji` | string | Emoji đại diện | `"💻"` |
| `identity.avatar` | string | Path ảnh avatar | `"~/.openclaw/avatar.png"` |
| `identity.theme` | string | Màu theme | `"blue"` |
| `default` | boolean | Agent mặc định | `true` |

---

### 2. 🧠 Model — Mô hình AI

| Field | Type | Mô tả | Ví dụ |
|---|---|---|---|
| `model.primary` | string | Model chính | `"anthropic/claude-opus-4-5"` |
| `model.fallbacks` | string[] | Model dự phòng | `["openai/gpt-4o"]` |
| `thinkingDefault` | string | Mức suy nghĩ mặc định | `"medium"` |
| `reasoningDefault` | string | Hiển thị reasoning | `"off"` |
| `fastModeDefault` | boolean | Fast mode | `false` |

**`thinkingDefault` options:** `"off"` `"minimal"` `"low"` `"medium"` `"high"` `"xhigh"` `"adaptive"`

**`reasoningDefault` options:** `"on"` `"off"` `"stream"`

---

### 3. 📁 Workspace — Không gian làm việc

| Field | Type | Mô tả | Ví dụ |
|---|---|---|---|
| `workspace` | string | Thư mục làm việc của agent | `"~/projects/my-app"` |

Workspace chứa các file cấu hình persona:

| File | Mô tả |
|---|---|
| `AGENTS.md` | Mô tả subagents |
| `SOUL.md` | Tính cách, giá trị, tone |
| `IDENTITY.md` | Vai trò, tên |
| `USER.md` | Thông tin về user |
| `TOOLS.md` | Chính sách tools |
| `HEARTBEAT.md` | Hành vi chủ động |
| `MEMORY.md` | Bộ nhớ dài hạn |

---

### 4. 💬 Human Delay — Delay tự nhiên

| Field | Type | Mô tả | Ví dụ |
|---|---|---|---|
| `humanDelay.mode` | string | `"off"` \| `"natural"` \| `"custom"` | `"natural"` |
| `humanDelay.minMs` | number | Delay tối thiểu (ms) | `800` |
| `humanDelay.maxMs` | number | Delay tối đa (ms) | `2500` |

---

### 5. 💓 Heartbeat — Chạy định kỳ

| Field | Type | Mô tả | Ví dụ |
|---|---|---|---|
| `heartbeat.every` | string | Chu kỳ chạy | `"30m"` `"1h"` |
| `heartbeat.activeHours.start` | string | Giờ bắt đầu (HH:MM) | `"08:00"` |
| `heartbeat.activeHours.end` | string | Giờ kết thúc | `"22:00"` |
| `heartbeat.model` | string | Model riêng cho heartbeat | `"openai/gpt-4o-mini"` |
| `heartbeat.isolatedSession` | boolean | Chạy session riêng (tiết kiệm token) | `true` |
| `heartbeat.lightContext` | boolean | Chỉ load HEARTBEAT.md | `true` |
| `heartbeat.prompt` | string | Custom heartbeat prompt | `"Check HEARTBEAT.md..."` |

---

### 6. 🛠 Skills — Kỹ năng

| Field | Type | Mô tả |
|---|---|---|
| `skills` | string[] | Danh sách skill được phép (omit = tất cả, `[]` = không có) |

---

### 7. 👥 Subagents — Agent con

| Field | Type | Mô tả | Ví dụ |
|---|---|---|---|
| `subagents.allowAgents` | string[] | Cho phép spawn agent nào | `["*"]` hoặc `["coder"]` |
| `subagents.model` | string | Model mặc định cho subagent | `"openai/gpt-4o"` |
| `subagents.requireAgentId` | boolean | Bắt buộc chỉ định agentId khi spawn | `false` |

---

### 8. 🔒 Tools — Công cụ

> Cấu hình qua workspace file `TOOLS.md` hoặc `tools` field trong config.

---

## Ví dụ config đầy đủ

```json5
{
  "id": "coder",
  "default": false,
  "name": "Coder",
  "identity": {
    "name": "Coda",
    "emoji": "💻",
    "theme": "blue"
  },
  "workspace": "~/projects/my-app",
  "model": {
    "primary": "anthropic/claude-opus-4-5",
    "fallbacks": ["openai/gpt-4o"]
  },
  "thinkingDefault": "high",
  "reasoningDefault": "off",
  "fastModeDefault": false,
  "humanDelay": {
    "mode": "natural"
  },
  "heartbeat": {
    "every": "1h",
    "activeHours": { "start": "09:00", "end": "18:00" },
    "isolatedSession": true,
    "lightContext": true
  },
  "skills": ["bash", "web-search"],
  "subagents": {
    "allowAgents": ["*"],
    "model": "openai/gpt-4o-mini"
  }
}
```

---

## Read/Write config qua WebSocket API

### Lấy config hiện tại của 1 agent

```js
// Lấy toàn bộ agents list
const result = await client.request("config.get", { path: "agents.list" });
const agentConfig = result.value.find(a => a.id === "coder");
```

### Cập nhật config 1 agent

```js
// Cập nhật model cho agent "coder"
const currentList = (await client.request("config.get", { path: "agents.list" })).value ?? [];
const updated = currentList.map(a =>
  a.id === "coder"
    ? { ...a, model: { primary: "anthropic/claude-opus-4-5" }, thinkingDefault: "high" }
    : a
);
await client.request("config.set", { path: "agents.list", value: updated });
```

### Lấy agents.list + agents.defaults cùng lúc

```js
const [listResult, defaultsResult] = await Promise.all([
  client.request("config.get", { path: "agents.list" }),
  client.request("config.get", { path: "agents.defaults" }),
]);
```

---

## UI Web — Form sửa cấu hình agent

Những field **nên hiển thị** trên form:

```
[ Identity ]
  Name        ___________
  Emoji       ___
  Theme       [dropdown]

[ Model ]
  Primary     ___________   [dropdown từ models.list]
  Fallbacks   ___________
  Thinking    [off|low|medium|high]
  Reasoning   [on|off|stream]

[ Workspace ]
  Path        ___________

[ Behavior ]
  Human Delay [off|natural|custom]
  Min delay   ___ms
  Max delay   ___ms

[ Heartbeat ]
  Enable      [toggle]
  Every       ___  [m|h]
  Active from ___  to  ___
  Light ctx   [toggle]

[ Skills ]
  Allowed     [multi-select]
```

---

## Socket.IO events cho 9remote

```js
// Agent side (socketio.js)

// Lấy config 1 agent
socket.on("agent:config:get", async ({ agentId }) => {
  const client = await getOpenClawClient();
  const { value: list } = await client.request("config.get", { path: "agents.list" });
  const config = (list ?? []).find(a => a.id === agentId) ?? null;
  socket.emit("agent:config:result", { agentId, config });
});

// Lưu config 1 agent
socket.on("agent:config:set", async ({ agentId, patch }) => {
  const client = await getOpenClawClient();
  const { value: list } = await client.request("config.get", { path: "agents.list" });
  const updated = (list ?? []).map(a => a.id === agentId ? { ...a, ...patch } : a);
  await client.request("config.set", { path: "agents.list", value: updated });
  socket.emit("agent:config:saved", { agentId });
});

// Lấy danh sách models có thể chọn
socket.on("models:list", async () => {
  const client = await getOpenClawClient();
  const result = await client.request("models.list", {});
  socket.emit("models:list:result", result);
});
```
