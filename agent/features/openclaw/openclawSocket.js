/**
 * OpenClaw Socket.IO namespace handler.
 * Bridges the web client (/openclaw namespace) with the OpenClaw WS gateway.
 */

import { randomUUID } from "crypto";
import {
  sendChat,
  abortChat,
  getChatHistory,
  listAgents,
  onChatEvent,
  isConnected,
  connectOpenClaw,
  getClient,
} from "./client.js";
import { synthesize } from "../tts/index.js";

// Listen for sessions.changed broadcast and forward as agent:progress
function setupSessionsChangedListener(ns) {
  const client = getClient();
  if (!client) return;
  client.onEvent("sessions.changed", (payload) => {
    ns.emit("agent:progress", {
      agentId: payload.agentId,
      running: payload.running ?? false,
      subagents: payload.subagents ?? [],
    });
  });
}

// Connect to OpenClaw on startup (non-blocking, auto-reconnects internally)
connectOpenClaw().catch((err) =>
  console.error("[openclaw] Initial connect failed:", err.message)
);

export function setupOpenClawSocket(io) {
  const ns = io.of("/openclaw");

  // Re-register sessions.changed listener once namespace is ready
  setupSessionsChangedListener(ns);

  ns.on("connection", (socket) => {
    // agents:list
    socket.on("agents:list", async (cb) => {
      try {
        const agents = await listAgents();
        if (typeof cb === "function") cb({ agents });
      } catch (err) {
        if (typeof cb === "function") cb({ agents: [], error: err.message });
      }
    });

    // agents:create
    socket.on("agents:create", async ({ name, emoji, workspace }, cb) => {
      try {
        const defaultWorkspace = `${process.env.HOME}/.openclaw/workspace-${name}`;
        const res = await getClient().request("agents.create", {
          name,
          emoji,
          workspace: workspace || defaultWorkspace,
        });
        if (typeof cb === "function") cb({ agent: res });
      } catch (err) {
        if (typeof cb === "function") cb({ error: err.message });
      }
    });

    // agents:delete
    socket.on("agents:delete", async ({ agentId }, cb) => {
      try {
        await getClient().request("agents.delete", { agentId });
        if (typeof cb === "function") cb({ ok: true });
      } catch (err) {
        if (typeof cb === "function") cb({ error: err.message });
      }
    });

    // agent:config:get
    socket.on("agent:config:get", async ({ agentId }, cb) => {
      try {
        console.log("[openclaw] agent:config:get called:", agentId);
        
        // Read directly from openclaw.json file (not RPC)
        const configPath = `${process.env.HOME}/.openclaw/openclaw.json`;
        const fs = await import("fs");
        
        const rawConfig = fs.readFileSync(configPath, "utf8");
        const openclawConfig = JSON.parse(rawConfig);
        
        // Find agent by id
        const agent = openclawConfig.agents?.list?.find(a => a.id === agentId);
        if (!agent) {
          console.warn("[openclaw] Agent not found in config:", agentId);
          if (typeof cb === "function") cb({ error: `Agent ${agentId} not found` });
          return;
        }
        
        console.log("[openclaw] Agent config loaded:", agent);
        
        if (typeof cb === "function") cb({ config: agent });
      } catch (err) {
        console.error("[openclaw] agent:config:get error:", err.message);
        if (typeof cb === "function") cb({ error: err.message });
      }
    });

    // agent:config:set — update agent config via RPC
    socket.on("agent:config:set", async ({ agentId, config }, cb) => {
      try {
        console.log("[openclaw] agent:config:set called:", { agentId, config });
        
        // Read openclaw.json and update directly
        const configPath = `${process.env.HOME}/.openclaw/openclaw.json`;
        const fs = await import("fs");
        
        const rawConfig = fs.readFileSync(configPath, "utf8");
        const openclawConfig = JSON.parse(rawConfig);
        
        if (!openclawConfig.agents) openclawConfig.agents = {};
        if (!openclawConfig.agents.list) openclawConfig.agents.list = [];
        
        const agentIndex = openclawConfig.agents.list.findIndex(a => a.id === agentId);
        
        if (agentIndex !== -1) {
          const agent = openclawConfig.agents.list[agentIndex];
          
          // Update identity
          if (config.identity) {
            if (!agent.identity) agent.identity = {};
            if (config.identity.name) agent.identity.name = config.identity.name;
            if (config.identity.emoji !== undefined) agent.identity.emoji = config.identity.emoji;
            if (config.identity.avatar !== undefined) agent.identity.avatar = config.identity.avatar;
          }
          
          // Update model
          if (config.model) agent.model = config.model;
          
          // Update workspace
          if (config.workspace) agent.workspace = config.workspace;
          
          // Update tools (allow/deny) - merge with existing alsoAllow
          if (config.tools) {
            if (!agent.tools) agent.tools = {};
            
            // Merge allow with existing alsoAllow to avoid conflict
            if (config.tools.allow !== undefined) {
              const existingAlsoAllow = agent.tools.alsoAllow || [];
              agent.tools.allow = [...new Set([...config.tools.allow, ...existingAlsoAllow])];
              // Remove alsoAllow to avoid conflict
              delete agent.tools.alsoAllow;
            }
            
            if (config.tools.deny !== undefined) {
              agent.tools.deny = config.tools.deny;
            }
          }
          
          console.log("[openclaw] Updated agent config:", agent);
          
          // Write back to file (OpenClaw will auto hot-reload)
          fs.writeFileSync(configPath, JSON.stringify(openclawConfig, null, 2), "utf8");
          console.log("[openclaw] Config written to:", configPath);
        } else {
          console.warn("[openclaw] Agent not found:", agentId);
        }
        
        if (typeof cb === "function") cb({ success: true });
      } catch (err) {
        console.error("[openclaw] agent:config:set error:", err.message);
        if (typeof cb === "function") cb({ error: err.message });
      }
    });

    // agent:files:get — read workspace file
    socket.on("agent:files:get", async ({ agentId, fileName }, cb) => {
      try {
        console.log("[openclaw] agent:files:get called:", { agentId, fileName });
        const res = await getClient().request("agents.files.get", { agentId, name: fileName });
        let content = res.file?.content || res.content || res;
        // Ensure content is string
        if (typeof content !== "string") {
          content = JSON.stringify(content, null, 2);
        }
        console.log("[openclaw] File loaded:", fileName, "length:", content?.length);
        if (typeof cb === "function") cb({ success: true, content });
      } catch (err) {
        console.error("[openclaw] agent:files:get error:", err.message);
        if (typeof cb === "function") cb({ success: false, error: err.message });
      }
    });

    // agent:files:set — write workspace file
    socket.on("agent:files:set", async ({ agentId, fileName, content }, cb) => {
      try {
        console.log("[openclaw] agent:files:set called:", { agentId, fileName, contentLength: content?.length });
        await getClient().request("agents.files.set", { agentId, name: fileName, content });
        console.log("[openclaw] File saved successfully:", fileName);
        if (typeof cb === "function") cb({ success: true });
      } catch (err) {
        console.error("[openclaw] agent:files:set error:", err.message);
        if (typeof cb === "function") cb({ success: false, error: err.message });
      }
    });

    // agent:config:patch — update agent-to-agent config
    socket.on("agent:config:patch", async ({ agentId, config }, cb) => {
      try {
        console.log("[openclaw] agent:config:patch called:", { agentId, config });
        
        const configPath = `${process.env.HOME}/.openclaw/openclaw.json`;
        const fs = await import("fs");
        
        const rawConfig = fs.readFileSync(configPath, "utf8");
        const openclawConfig = JSON.parse(rawConfig);
        
        if (!openclawConfig.agents) openclawConfig.agents = {};
        if (!openclawConfig.agents.list) openclawConfig.agents.list = [];
        
        const agentIndex = openclawConfig.agents.list.findIndex(a => a.id === agentId);
        
        if (agentIndex !== -1) {
          const agent = openclawConfig.agents.list[agentIndex];
          
          // Update agentToAgent config (subagents.allowAgents)
          if (config.agentToAgent) {
            if (!agent.subagents) agent.subagents = {};
            if (config.agentToAgent.allow !== undefined) {
              agent.subagents.allowAgents = config.agentToAgent.allow;
            }
          }
          
          // Write back to file (OpenClaw will auto hot-reload)
          fs.writeFileSync(configPath, JSON.stringify(openclawConfig, null, 2), "utf8");
          console.log("[openclaw] Config written to:", configPath);
          
          // Auto-approve pending backend client devices for agent-to-agent communication
          try {
            const pendingPath = `${process.env.HOME}/.openclaw/devices/pending.json`;
            if (fs.existsSync(pendingPath)) {
              const pendingDevices = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
              
              // Only approve backend gateway-client devices (not user devices)
              for (const [requestId, device] of Object.entries(pendingDevices)) {
                if (device.clientId === "gateway-client" && device.clientMode === "backend") {
                  console.log("[openclaw] Auto-approving backend client device:", requestId);
                  try {
                    await getClient().request("devices.approve", { requestId });
                    console.log("[openclaw] Auto-approved backend device:", requestId);
                    
                    // Wait a bit for approval to take effect
                    await new Promise(resolve => setTimeout(resolve, 500));
                  } catch (err) {
                    console.warn("[openclaw] Failed to approve backend device:", requestId, err.message);
                  }
                } else {
                  console.log("[openclaw] Skipping non-backend device:", requestId, device.clientId);
                }
              }
            }
          } catch (err) {
            console.warn("[openclaw] Failed to check/approve pending devices:", err.message);
          }
        } else {
          console.warn("[openclaw] Agent not found:", agentId);
        }
        
        if (typeof cb === "function") cb({ success: true });
      } catch (err) {
        console.error("[openclaw] agent:config:patch error:", err.message);
        if (typeof cb === "function") cb({ success: false, error: err.message });
      }
    });

    // models:list
    socket.on("models:list", async (cb) => {
      try {
        const res = await getClient().request("models.list", {});
        if (typeof cb === "function") cb({ models: res.models ?? res });
      } catch (err) {
        if (typeof cb === "function") cb({ models: [], error: err.message });
      }
    });

    // devices:approve — manual approve pending device
    socket.on("devices:approve", async ({ requestId }, cb) => {
      try {
        console.log("[openclaw] devices:approve called:", requestId);
        await getClient().request("devices.approve", { requestId });
        console.log("[openclaw] Device approved:", requestId);
        if (typeof cb === "function") cb({ success: true });
      } catch (err) {
        console.error("[openclaw] devices:approve error:", err.message);
        if (typeof cb === "function") cb({ success: false, error: err.message });
      }
    });

    // chat:history
    socket.on("chat:history", async ({ sessionKey, limit = 50 }, cb) => {
      try {
        const messages = await getChatHistory(sessionKey, limit);
        if (typeof cb === "function") cb({ messages });
      } catch (err) {
        if (typeof cb === "function") cb({ messages: [], error: err.message });
      }
    });

    // chat:send — send message, stream response back
    socket.on("chat:send", async ({ sessionKey, message, attachments }) => {
      console.log("[openclaw] chat:send called:", { sessionKey, messageLength: message?.length, hasAttachments: !!attachments });
      
      // Wait up to 2s for connection if currently reconnecting
      if (!isConnected()) {
        console.warn("[openclaw] Not connected, waiting...");
        await new Promise((res) => setTimeout(res, 2000));
        if (!isConnected()) {
          console.error("[openclaw] Still not connected after 2s");
          socket.emit("chat:error", { runId: null, error: "OpenClaw not connected" });
          return;
        }
      }
      try {
        const idempotencyKey = randomUUID();
        console.log("[openclaw] Sending chat with idempotencyKey:", idempotencyKey);
        const runId = await sendChat(sessionKey, message, { idempotencyKey, attachments });
        console.log("[openclaw] Chat accepted, runId:", runId);
        // Notify client that message was accepted
        socket.emit("chat:accepted", { runId, sessionKey });

        let fullText = "";

        onChatEvent(runId, async ({ state, message: msg, errorMessage }) => {
          console.log("[openclaw] Chat event:", { runId, state, hasMessage: !!msg, errorMessage });
          if (state === "delta") {
            const text = msg?.content?.[0]?.text ?? msg?.text ?? "";
            const chunk = text.slice(fullText.length);
            fullText = text;
            if (chunk) socket.emit("chat:delta", { runId, text: chunk });
          } else if (state === "final" || state === "aborted") {
            socket.emit("chat:done", { runId, sessionKey });
            // TTS: synthesize full response and send audio
            if (fullText.length > 0) {
              try {
                const ttsResult = await synthesize(fullText);
                socket.emit("chat:audio", {
                  audio: ttsResult.audio,
                  format: ttsResult.format,
                  engine: ttsResult.engine,
                });
              } catch (err) {
                console.warn("[openclaw] TTS failed:", err.message);
              }
            }
          } else if (state === "error") {
            // If we already sent some chunks, emit done (backend error post-response)
            if (fullText.length > 0) {
              socket.emit("chat:done", { runId, sessionKey });
            } else {
              socket.emit("chat:error", { runId, error: errorMessage || "Chat error" });
            }
          }
        });
      } catch (err) {
        socket.emit("chat:error", { runId: null, error: err.message });
      }
    });

    // chat:abort
    socket.on("chat:abort", async ({ sessionKey }) => {
      try {
        await abortChat(sessionKey);
      } catch (err) {
        console.error("[openclaw] abort error:", err.message);
      }
    });
  });
}
