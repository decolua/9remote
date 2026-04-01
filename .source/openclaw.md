# OpenClaw — Technical Summary

## Overview
OpenClaw là một **Personal AI Assistant** chạy self-hosted. Phiên bản hiện tại: `2026.3.30`. Là một multi-channel AI gateway hỗ trợ 30+ kênh messaging (WhatsApp, Telegram, Slack, Discord, Zalo...). Runtime: Node 24, built bằng TypeScript, package manager: pnpm.

## Kiến trúc tổng quan
```
Client (WebChat/UI/CLI)
    ↓ WebSocket / HTTP
Gateway (port 18789)
    ├── Agent System (chat, LLM routing)
    ├── Channel Plugins (30+ channels)
    ├── Provider Plugins (OpenAI, Anthropic, Google...)
    ├── Session Management
    ├── Config System
    └── Plugin SDK
```

## 1. Gateway
- **Port mặc định**: `18789`
- **Protocol**: WebSocket (JSON-RPC style) + HTTP endpoints
- **Auth modes**: `none` | `token` | `password` | `trusted-proxy`
- **Config file**: `~/.openclaw/openclaw.json` (JSON5)
- **State dir**: `~/.openclaw/`

### WebSocket Protocol
Wire format là JSON frames:
```json
// Request
{ "type": "req", "id": "uuid", "method": "chat.send", "params": {...} }

// Response
{ "type": "res", "id": "uuid", "ok": true, "payload": {...} }

// Server-push event
{ "type": "event", "event": "chat", "payload": {...}, "seq": 1 }
```

### Connect Handshake
1. Client gửi `{ type: "req", method: "connect", params: { client, minProtocol, maxProtocol, role, auth } }`
2. Server trả `{ type: "hello-ok", protocol, server, features: { methods[], events[] }, snapshot, policy }`
3. Sau handshake, client có thể gọi methods và nhận events

### HTTP Endpoints (opt-in via config)
| Endpoint | Mô tả |
|---|---|
| `POST /v1/chat/completions` | OpenAI-compatible chat completion (streaming SSE) |
| `POST /v1/responses` | OpenResponses API |
| `POST /tools/invoke` | Invoke gateway tools |
| `GET /health` | Health check |
| Static `/control-ui` | Web dashboard UI |

### Roles & Scopes
- `operator` — full access (CLI, desktop app)
- `webchat` — chat-only (browser client)
- `node` — machine-to-machine (sandbox, plugins)

## 2. Chat / Agent System

### Chat Methods (via WebSocket)
| Method | Mô tả | Params chính |
|---|---|---|
| `chat.send` | Gửi message, trigger agent run | `sessionKey`, `message`, `deliver?`, `images?`, `thinking?` |
| `chat.abort` | Hủy active chat run | `runId` |
| `chat.history` | Lấy transcript history | `sessionKey` |
| `chat.inject` | Inject assistant text vào transcript | `sessionKey`, `message` |
| `agent` | Run agent turn (full LLM) | `message`, `sessionKey?`, `agentId?`, `deliver?` |
| `agent.wait` | Poll agent completion | `runId` |

### Chat Flow
1. Client gửi `chat.send` → server trả `{ runId, status: "accepted" }` (immediate ack)
2. Server emit streaming events: `{ event: "chat", state: "delta", text }` (incremental)
3. Agent xử lý qua LLM → emit `delta` events
4. Khi xong: emit `{ event: "chat", state: "final" }`
5. Khi lỗi: emit `{ event: "chat", state: "error", error }`

### Sessions
- `sessionKey` dạng: `"main"`, `"direct:discord:123456"`, `"dm"`
- Transcripts lưu dạng line-delimited JSON files trên disk
- Session management: `sessions.list`, `sessions.create`, `sessions.reset`, `sessions.delete`, `sessions.compact`

## 3. Configuration System

### Config Methods (via WebSocket)
| Method | Mô tả |
|---|---|
| `config.get` | Đọc config values |
| `config.set` | Ghi single config path |
| `config.patch` | Merge partial config |
| `config.apply` | Apply full config object |
| `config.schema` | Lấy config schema metadata |
| `config.schema.lookup` | Lookup specific schema path |

### Config Structure (key sections)
```json5
{
  "gateway": {
    "port": 18789,
    "auth": { "mode": "token", "token": "..." },
    "http": { "endpoints": { "chatCompletions": { "enabled": true } } }
  },
  "channels": { /* channel-specific configs */ },
  "providers": { /* model provider configs */ },
  "models": { /* model configs */ },
  "agents": { /* agent configs */ },
  "plugins": { "entries": { /* plugin registry */ } }
}
```

## 4. CLI Commands
| Command | Mô tả |
|---|---|
| `openclaw gateway` | Start gateway daemon |
| `openclaw onboard` | Interactive setup wizard |
| `openclaw agent --message "..."` | Chat với AI assistant |
| `openclaw message send --to <target> --message "..."` | Gửi tin nhắn đến channel |
| `openclaw config get/set` | Đọc/ghi config |
| `openclaw doctor` | Health check |
| `openclaw tui` | Terminal UI mode |

## 5. Plugin SDK
- Public API surface: `openclaw/plugin-sdk/*`
- Extension code chỉ được import qua plugin-sdk, không import `src/**` trực tiếp
- 3 loại plugin chính: **Channel** (messaging), **Provider** (LLM), **Tool** (capabilities)

## 6. Key Gateway Methods (Full List)
### Core
`connect`, `health`, `status`, `shutdown`, `reload`

### Chat & Agent
`chat.send`, `chat.abort`, `chat.history`, `chat.inject`, `agent`, `agent.wait`, `agent.identity.get`

### Config
`config.get`, `config.set`, `config.patch`, `config.apply`, `config.schema`, `config.schema.lookup`

### Channels
`channels.status`, `channels.logout`, `send` (outbound message)

### Models & Providers
`models.list`

### Sessions
`sessions.list`, `sessions.create`, `sessions.send`, `sessions.reset`, `sessions.delete`, `sessions.compact`, `sessions.subscribe`, `sessions.unsubscribe`, `sessions.preview`, `sessions.patch`, `sessions.usage`

### Agents
`agents.list`, `agents.create`, `agents.update`, `agents.delete`, `agents.files.*`

### Tools & Skills
`tools.catalog`, `tools.effective`, `skills.status`, `skills.install`, `skills.update`

### System
`cron.*`, `secrets.*`, `logs.tail`, `usage.*`, `update.run`, `exec.approval.*`, `plugin.approval.*`

### Devices & Nodes
`device.pair.*`, `node.pair.*`, `node.list`, `node.invoke`, `node.event`

### Voice & Talk
`talk.config`, `talk.speak`, `talk.mode`, `voicewake.get/set`

## 7. Key Dependencies
- **ws** — WebSocket server
- **express** / **hono** — HTTP routing
- **zod** — Schema validation
- **undici** — HTTP client
- **sharp** — Image processing
- **sqlite-vec** — Vector search (memory)
- **playwright-core** — Browser automation

## 8. Source Structure
```
src/
├── gateway/          # Gateway server, protocol, WebSocket handling
│   └── protocol/     # Wire protocol schema & types
├── chat/             # Chat message handling
├── agents/           # Agent system (multi-agent routing)
├── channels/         # Core channel implementations
├── config/           # Config types & management
├── cli/              # CLI wiring
├── commands/         # CLI command implementations
├── plugin-sdk/       # Public plugin SDK surface
├── plugins/          # Plugin discovery, loader, registry
├── routing/          # Message routing logic
├── sessions/         # Session management
├── mcp/              # Model Context Protocol
├── web-search/       # Web search integration
├── tts/              # Text-to-speech
├── media/            # Media pipeline
├── security/         # Auth, pairing, permissions
└── extensions/       # Extension API surface
```
