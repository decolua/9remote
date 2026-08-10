import { DurableObject } from "cloudflare:workers";

// Worker-level route handler — gates WS upgrade on apiKey, fans out to room DO.
// Auth mirrors /api/connect: a live session row for this apiKey must exist.
export async function handleSignaling(request, env) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/signaling\/ws\/([^/]+)$/);
  if (!match) return new Response("Not found", { status: 404 });

  const upgrade = request.headers.get("Upgrade");
  if (!upgrade || upgrade !== "websocket") {
    return new Response("Expected Upgrade: websocket", { status: 426 });
  }

  const role = url.searchParams.get("role");
  if (role !== "agent" && role !== "client") {
    return new Response("Invalid role (agent|client)", { status: 400 });
  }

  // apiKey gate — no valid session = no signaling. Stops RTC-bypass of device approval.
  const apiKey = url.searchParams.get("apiKey");
  if (!apiKey) return new Response("Missing apiKey", { status: 401 });
  const session = await env.DB.prepare("SELECT 1 FROM sessions WHERE apiKey = ?").bind(apiKey).first();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const roomId = decodeURIComponent(match[1]);
  const id = env.SIGNALING_DO.idFromName(roomId);
  return env.SIGNALING_DO.get(id).fetch(request);
}

// Forward-only relay. DO stays dumb about SDP/ICE semantics. One room = one deviceId,
// two roles (agent + client). WebSocket Hibernation: ping/pong auto-replied by runtime,
// never wakes the DO, never billed while idle.
export class SignalingDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    // peerId identifies a specific client (deviceId:tab). Multiple clients share
    // a room (room = apiKey), so role alone can't address them.
    const peerId = url.searchParams.get("from") || null;
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role, peerId });
    return new Response(null, { status: 101, webSocket: client });
  }

  // Route by peerId when addressed to a specific client, by role otherwise
  // ("agent" — exactly one per room).
  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    const { to, from, type, payload } = msg;
    if (!to || !type) return;
    const target = this.ctx.getWebSockets().find((peer) => {
      if (peer === ws) return false;
      const att = peer.deserializeAttachment();
      return to === "agent" ? att?.role === "agent" : att?.peerId === to;
    });
    if (target) target.send(JSON.stringify({ type, payload, from }));
  }

  async webSocketClose() {}
}
