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
          workspace: workspace || defaaultWorkspace,
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
        const res = await getClient().request("agents.list", {});
        
        // Find agent by id
        const agent = res.agents?.find(a => a.id === agentId);
        if (!agent) {
          console.error("[openclaw] agent:config:get - agent not found:", agentId);
          if (typeof cb === "function") cb({ error: `Agent ${agentId} not found` });
          return;
        }
        
        // Also get full config to check tools.agentToAgent
        const fullConfig = await getClient().request("config.get", {});
        const cfg = fullConfig.config;
        
        // Merge agent config with global tools.agentToAgent
        const agentConfig = {
          ...agent,
          agentToAgent: {
            enabled: cfg.tools?.agentToAgent?.enabled || false,
            allow: cfg.tools?.agentToAgent?.allow || []
          }
        };
        
        console.log("[openclaw] agent:config:get - returning:", JSON.stringify(agentConfig, null, 2));
        if (typeof cb === "function") cb({ config: agentConfig });
      } catch (err) {
        console.error("[openclaw] agent:config:get - error:", err.message);
        if (typeof cb === "function") cb({ error: err.message });
      }
    });

    // agent:config:set — patch agent config
    socket.on("agent:config:set", async ({ agentId, config }, cb) => {
      console.log("[openclaw] agent:config:set - agentId:", agentId);
      console.log("[openclaw] agent:config:set - config:", JSON.stringify(config, null, 2));
      try {
        const res = await getClient().request("agents.update", { agentId, ...config });
        console.log("[openclaw] agent:config:set - response:", JSON.stringify(res, null, 2));
        if (typeof cb === "function") cb({ config: res });
      } catch (err) {
        console.error("[openclaw] agent:config:set - error:", err.message);
        if (typeof cb === "function") cb({ error: err.message });
      }
    });

    // agent:files:get — read workspace file
    socket.on("agent:files:get", async ({ agentId, fileName }, cb) => {
      try {
        const res = await getClient().request("agents.files.get", { agentId, name: fileName });
        let content = res.file?.content || res.content || res;
        // Ensure content is string
        if (typeof content !== "string") {
          content = JSON.stringify(content, null, 2);
        }
        if (typeof cb === "function") cb({ success: true, content });
      } catch (err) {
        if (typeof cb === "function") cb({ success: false, error: err.message });
      }
    });

    // agent:files:set — write workspace file
    socket.on("agent:files:set", async ({ agentId, fileName, content }, cb) => {
      try {
        await getClient().request("agents.files.set", { agentId, name: fileName, content });
        if (typeof cb === "function") cb({ success: true });
      } catch (err) {
        if (typeof cb === "function") cb({ success: false, error: err.message });
      }
    });

    // agent:config:patch — patch OpenClaw config (hot-reload)
    socket.on("agent:config:patch", async ({ agentId, config }, cb) => {
      console.log("[openclaw] agent:config:patch - agentId:", agentId, "config:", JSON.stringify(config, null, 2));
      try {
        // Get current config
        const currentConfig = await getClient().request("config.get", {});
        const baseHash = currentConfig.hash;
        const cfg = currentConfig.config;
        
        console.log("[openclaw] Current tools.agentToAgent:", JSON.stringify(cfg.tools?.agentToAgent, null, 2));
        
        // Find agent index in agents.list
        const agentsList = cfg.agents?.list || [];
        const agentIndex = agentsList.findIndex(a => a.id === agentId);
        
        // Build agent config (only valid OpenClaw fields)
        const agentConfig = {
          id: agentId,
          workspace: config.workspace,
          model: config.model,
          identity: config.identity,
          tools: config.tools
        };
        
        // Remove empty/undefined fields
        Object.keys(agentConfig).forEach(key => {
          if (!agentConfig[key] || (typeof agentConfig[key] === 'string' && !agentConfig[key].trim())) {
            delete agentConfig[key];
          }
        });
        
        let newList;
        if (agentIndex === -1) {
          // Agent not in config yet, add it
          newList = [...agentsList, agentConfig];
        } else {
          // Agent exists, update it
          newList = [...agentsList];
          newList[agentIndex] = { ...agentsList[agentIndex], ...agentConfig };
        }
        
        const patch = {
          agents: {
            list: newList
          }
        };
        
        // Patch global tools.agentToAgent - MUST include ALL agents that can interact
        if (config.agentToAgent?.enabled) {
          // Get all agent IDs
          const allAgentIds = newList.map(a => a.id);
          
          patch.tools = {
            agentToAgent: {
              enabled: true,
              allow: allAgentIds  // Allow all agents to interact
            }
          };
          
          console.log("[openclaw] Setting tools.agentToAgent.allow:", allAgentIds);
        }
        
        console.log("[openclaw] agent:config:patch - patch:", JSON.stringify(patch, null, 2));
        const result = await getClient().request("config.patch", {
          raw: JSON.stringify(patch),
          baseHash
        });
        
        console.log("[openclaw] agent:config:patch - success");
        if (typeof cb === "function") cb({ success: true, result });
      } catch (err) {
        console.error("[openclaw] agent:config:patch - error:", err.message);
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
      // Wait up to 2s for connection if currently reconnecting
      if (!isConnected()) {
        await new Promise((res) => setTimeout(res, 2000));
        if (!isConnected()) {
          socket.emit("chat:error", { runId: null, error: "OpenClaw not connected" });
          return;
        }
      }
      try {
        const idempotencyKey = randomUUID();
        const runId = await sendChat(sessionKey, message, { idempotencyKey, attachments });
        // Notify client that message was accepted
        socket.emit("chat:accepted", { runId, sessionKey });

        let fullText = "";

        onChatEvent(runId, async ({ state, message: msg, errorMessage }) => {
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
