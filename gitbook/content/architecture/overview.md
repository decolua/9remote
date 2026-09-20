# Architecture & Transport

Understand how 9Remote achieves sub-50ms latency, persistent terminal sessions, and seamless NAT traversal without open ports.

## High-Level Architecture

9Remote consists of three main components communicating across a dual-carrier transport protocol:

```text
┌────────────────────────────────┐
│      Host Computer (Agent)     │
│  - Node CLI / Desktop Wrapper  │
│  - Persistent PTY Daemon       │
│  - TileManager & JPEG Engine   │
└───────────────┬────────────────┘
                │
         [Transport Layer]
       (WebRTC P2P + Tunnel)
                │
┌───────────────▼────────────────┐         ┌───────────────────────────┐
│     Client (Browser / Mobile)  │ ◄───────┤    Cloudflare Edge API    │
│  - Next.js Web App / Expo App  │Signaling│ - Durable Objects Broker  │
│  - Service Worker Site Bridge  │         │ - Cloudflare Tunnel / D1  │
└────────────────────────────────┘         └───────────────────────────┘
```

---

## 1. Hybrid Transport Layer

Reliable remote access must work across mobile cellular towers, coffee shop Wi-Fi, and corporate firewalls. 9Remote uses a **three-carrier transport abstraction** managed by identical `ProtocolManager` engines on both the host agent and the client web app:

### Carrier 1: Cloudflare Durable Objects (Signaling)
- Used during initial handshake to exchange WebRTC session descriptions (SDP offers/answers) and ICE candidates.
- Backed by low-latency Cloudflare Durable Objects to ensure instant connection brokering.

### Carrier 2: WebRTC Data Channels (Primary Data Path)
- Once signaling completes, client and host establish a direct peer-to-peer UDP connection via **WebRTC Data Channels** (`node-datachannel` on the host agent, native `RTCPeerConnection` in browsers).
- **Latency:** Sub-50ms round-trip.
- Carries high-frequency data: screen frame tiles, terminal keystrokes, and touch events.

### Carrier 3: Cloudflare Tunnel WebSocket (Fallback Data Path)
- If strict symmetric NATs, enterprise firewalls, or deep packet inspection block peer-to-peer UDP traffic, 9Remote automatically falls back to an encrypted WebSocket running over a Cloudflare Tunnel.
- Connection never drops; it transparently degrades to the tunnel without user intervention.

---

## 2. Persistent PTY Daemon (`ptyDaemon`)

Traditional SSH or remote terminals tie shell processes directly to the network connection or the server process. If the server restarts or the network drops, running processes are terminated with `SIGHUP`.

9Remote solves this with an isolated **PTY Daemon architecture**:

```text
[ 9Remote Agent (CLI) ]
         │ (Unix Domain Socket / Named Pipe)
         ▼
[ Persistent PTY Daemon (Daemon Process) ]
         ├── Session 1: bash (PID 4012) -> vim
         ├── Session 2: zsh  (PID 4018) -> npm run dev
         └── Session 3: claude (PID 4025) -> AI Agent
```

- **Process Isolation:** The PTY daemon runs as an independent detached background process communicating with the 9Remote agent over a local Unix socket (`/tmp/9remote-pty.sock`) or Windows named pipe.
- **Survive Restarts:** If you update the 9Remote npm package, restart the agent, or reboot the UI, the daemon keeps all terminal sessions, shell history, and long-running builds running undisturbed.
- **Reattachment:** When the agent comes back online, it reconnects to the daemon and immediately restores all active terminals.

---

## 3. Remote Desktop Streaming Pipeline

Streaming high-resolution screens without high bandwidth requires aggressive optimization:

1. **Native Screen Capture:** Host capture engines use OS-level APIs (DXGI Desktop Duplication on Windows, CoreGraphics/ScreenCaptureKit on macOS).
2. **Dirty-Tile Diffing (`TileManager`):** The screen is partitioned into grid tiles. 9Remote tracks checksum hashes for each tile and only encodes rectangles that actually changed since the last frame.
3. **Turbo Compression:** Changed tiles are compressed using native turbo JPEG pipelines (`@julusian/jpeg-turbo` on Windows, native image bindings on macOS/Linux), keeping host CPU consumption under 5%.
4. **Adaptive Bitrate:** Tile quality and frame pacing dynamically scale depending on measured WebRTC network buffer pressure.

---

## 4. Local Site Browser Bridge

The **Site Browser** enables you to view `localhost:3000` on your mobile phone without port forwarding:
- In the client browser, a dedicated **Service Worker** intercepts requests under `/workspace/browse/*`.
- Requests are serialized and dispatched across the 9Remote data channel to the host agent.
- The host agent performs the HTTP or WebSocket request against the local loopback (`127.0.0.1:<port>`) and streams headers, status codes, and chunked body data back to the Service Worker.
- Assets (CSS, JS, images) and live-reloads render seamlessly.

---

## Next Steps

- Review [Security & Authentication](security)
- Learn about [Background Services & Daemon](../guides/services)
