# Transport

Multi-adapter (WS+RTC) orchestrator. Auto fallback. WS = bootstrap+signaling, RTC = data plane khi sẵn sàng.

## Files

```
web/shared/transport/         agent/transport/
ProtocolManager.js     ◀──▶  ProtocolManager.js   orchestrator
BaseProtocol.js               BaseProtocol.js     adapter contract
WsProtocol.js                 WsProtocol.js       socket.io adapter
WebRtcProtocol.js             WebRtcProtocol.js   DC adapter
codec.js                      codec.js            JSON envelope (Buffer↔base64)
registry.js                   registry.js         adapter plugin map
adapters/{Tunnel,LocalFirst}  broadcast.js        active PMs registry
                              server.js           io.on(connection) → PM per socket

constants:
web/shared/constants/transport.js
agent/lib/transportConstants.js
```

## Adapter contract

```js
class XProtocol extends BaseProtocol {
  static id           // "ws"|"rtc"|"quic"...
  static capabilities = { control: bool, binary: bool, signaling: "ws"|"external"|"none" }
  static priority     = { control: int, binary: int }

  connect(ctx)
  disconnect()
  send(channel, payload)   // channel ∈ "control"|"binary"

  // emits: stateChange(state), message({event,data,source}), error(err)
}
```

| id | priority.control | priority.binary | signaling |
|---|---|---|---|
| ws | 100 | 10 | ws |
| rtc | 50 | 100 | external (qua ws) |

`state` ∈ `idle|connecting|open|degraded|closed`. `ready` = state==="open".

## Channel routing

```js
_pickAdapter(channel):
  c = adapters.filter(a => a.supports(channel) && a.ready)
  if profile.channels[channel].prefer:
    return c.find(a => a.id === prefer)   // hard override
  return c.sort by priority[channel] desc [0]
```

Default profile: cả `control` lẫn `binary` đều `prefer:"rtc"`.

## Wire format

### WS
- `socket.emit(event, ...args, cb?)` — socket.io native (binary engine.io packet, multi-arg, ack).

### RTC envelope (DC `"control"`, JSON string)
```json
{ "event": "joinSession", "args": ["session-1"], "ackId": "c_42" }
{ "event": "__ack",       "args": [response],    "ackId": "c_42" }
```

### Buffer encoding (codec.js)
- Web: `Uint8Array` → `{__b: btoa(...)}`
- Agent: `Buffer.toJSON() {type:"Buffer",data:[]}` → `{__b: base64}`
- Decode ngược lại trên 2 phía.

### RTC binary (DC `"binary"`)
- Raw `ArrayBuffer`, `unordered`, `maxPacketLifeTime: 200ms`. Tile frames.

## Ack (RTC tự synthesize)

```
Client  emit(ev, cb)
        → pop cb, ackId="c_N", _pendingAcks.set(ackId, cb)
        → RTC send {event, args, ackId}, timeout 30s

Agent   _dispatch source="rtc"
        → push synthetic cb vào args (gọi → _sendAck)
        → handler(...args)
        → cb(resp) → RTC send {event:"__ack", args:[resp], ackId}

Client  _dispatch event="__ack"
        → _pendingAcks.get(ackId)(...args), delete
```

WS dùng socket.io ack native (không qua codec).

## Bootstrap

```
Client PM.connect()
  → instantiate ws → ws.connect → onOpen
  → _onAdapterStateChange(ws, open):
      _rebindProxyListeners
      _installSignalingListeners
      _startSecondaryAdapters → instantiate rtc → rtc.connect
        → createOffer → sendSignaling type="offer" qua WS
                      ↓
Agent (đã có PM tạo trong server.js attachTransportBus)
  → onWebrtcOffer → WebRtcProtocol._processOffer
  → answer + ICE qua WS
  → cả 2 DC open → state="open" cả 2 phía
```

Signaling event WS:
- `webrtc:offer {sdp}`
- `webrtc:answer {sdp}`
- `webrtc:ice-candidate {candidate, mid}`
- `webrtc:error {message}`

## Fallback

| Sự kiện | Hành vi |
|---|---|
| WS degraded, RTC ready | suppress onDisconnect. WS auto reconnect. |
| WS reconnect | `_restartRtc`: tear down + negotiate lại với PM mới của agent |
| RTC closed, WS ready | onFallback("ws"). Mọi emit về WS. |
| Cả 2 down | connected=false. Buffer pending sends, flush khi adapter open. |

## Proxy socket (`socketRef.current`)

KHÔNG phải raw socket.io socket. Object:

```js
{
  emit(event, ...args)  → pm._sendControl(event, args)
  on(event, h)          → _proxyListeners.add + raw.on (nếu có)
  off, once, listeners, disconnect
  get connected         → pm._anyAdapterReady()
}
```

Lý do: WS reconnect tạo socket mới → handlers cũ mất. PM giữ `_proxyListeners`, mỗi reconnect → `_rebindProxyListeners()` đính lại lên raw mới.

## Server `attachAsBus(socket)` (agent)

```js
socket._rawEmit = socket.emit.bind(socket)
socket.emit = (event, ...args) => {
  if (reserved.has(event)) return rawEmit(...)   // disconnect/error/connect/...
  pm._sendControl(event, args)                    // → RTC nếu prefer ready
}
```

Mọi feature `socket.emit("output", data)` tự đi qua PM. `WsProtocol.send` dùng `_rawEmit` tránh recursion.

## Broadcast registry (agent)

`agent/transport/broadcast.js`:
```js
const active = new Set()
registerProtocol(pm)     // gọi trong attachTransportBus
unregisterProtocol(pm)   // sau grace period
broadcast(_io, event, data) → active.forEach(pm => pm.emit(event, data))
```

Output terminal/file events/notifications dùng `broadcast()` thay `io.emit()` — vì WS block sẽ xoá socket khỏi `io.sockets`, RTC peer vẫn alive.

## Profile config

```js
TRANSPORT_PROFILES = {
  clientApp:     { enabled:["ws","rtc"], channels:{ control:{prefer:"rtc"}, binary:{prefer:"rtc"} } },
  remoteDesktop: { enabled:["ws","rtc"], channels:{ control:{prefer:"rtc"}, binary:{prefer:"rtc"} } }
}
```

Chọn qua `enableWebRTC` flag. Tắt RTC → `enabled:["ws"]`.

## Thêm protocol mới (vd QUIC)

1. `class QuicProtocol extends BaseProtocol` + static fields.
2. Implement `connect/disconnect/send`. Reuse `codec.js`.
3. `registerProtocol(QuicProtocol)` 2 phía.
4. Thêm `"quic"` vào `TRANSPORT_PROFILES.*.enabled`.
5. Set `prefer:"quic"` nếu muốn ưu tiên.

→ 0 đụng feature code.
