"use client";

import { useState, useEffect, useCallback } from "react";
import { LIVE2D_MODELS } from "@/shared/lib/live2d-manager";

const VOICES = {
  "vi-VN-HoaiMyNeural": "Hoài My (Nữ)",
  "vi-VN-NamMinhNeural": "Nam Minh (Nam)",
};

const THINKING_OPTIONS = ["off", "low", "medium", "high", "xhigh"];

export default function AgentConfigModal({ isOpen, onClose, agentId, socketRef }) {
  const [activeTab, setActiveTab] = useState("identity");
  const [config, setConfig] = useState({
    // Identity
    identityName: "",
    identityEmoji: "",
    identityAvatar: "",
    workspace: "",
    live2dModelId: "pio",
    backgroundUrl: "",
    voiceId: "vi-VN-HoaiMyNeural",
    audioEnabled: true,
    // Advanced
    model: "",
    thinking: "off",
    identityMd: "", // IDENTITY.md content
    soulMd: "",     // SOUL.md content
    agentsMd: "",   // AGENTS.md content
    companyMembers: [], // Array of agent IDs
    // Agent-to-Agent interaction
    agentToAgentEnabled: false,
    // Tools config
    toolsAllow: [], // e.g., ["read", "browser", "sessions_send"]
    toolsDeny: [],  // e.g., ["write", "exec"]
  });
  const [modelsList, setModelsList] = useState([]);
  const [availableAgents, setAvailableAgents] = useState([]); // All agents for dropdown
  const [loading, setLoading] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);

  // Available tools list
  const AVAILABLE_TOOLS = [
    "read", "write", "exec", "browser", 
    "sessions_send", "sessions_spawn",
    "filesystem", "git", "search"
  ];

  useEffect(() => {
    if (!isOpen || !socketRef.current) return;
    setLoading(true);
    setLoadingFiles(true);

    // Load agent config
    socketRef.current.emit("agent:config:get", { agentId }, (res) => {
      if (res?.config) {
        const c = res.config;
        setConfig((prev) => ({
          ...prev,
          identityName: c.identity?.name || "",
          identityEmoji: c.identity?.emoji || "",
          identityAvatar: c.identity?.avatar || "",
          workspace: c.workspace || "",
          live2dModelId: c._9remote?.live2dModelId || "pio",
          backgroundUrl: c._9remote?.backgroundUrl || "",
          voiceId: c._9remote?.voiceId || "vi-VN-HoaiMyNeural",
          audioEnabled: c._9remote?.audioEnabled !== false,
          model: c.model || "",
          thinking: c.thinking || "off",
          agentToAgentEnabled: c.agentToAgent?.enabled || false,
          toolsAllow: c.tools?.allow || [],
          toolsDeny: c.tools?.deny || [],
        }));
      }
      setLoading(false);
    });

    // Load models list
    socketRef.current.emit("models:list", (res) => {
      if (res?.models) setModelsList(res.models);
    });

    // Load available agents for dropdown
    socketRef.current.emit("agents:list", (res) => {
      if (res?.agents) {
        // Filter out current agent
        const others = res.agents.filter(a => a.id !== agentId);
        setAvailableAgents(others);
      }
    });

    // Load workspace files (IDENTITY.md, SOUL.md, AGENTS.md)
    const loadFiles = async () => {
      const files = ["IDENTITY.md", "SOUL.md", "AGENTS.md"];
      const results = {};
      
      for (const fileName of files) {
        await new Promise((resolve) => {
          socketRef.current.emit("agent:files:get", { agentId, fileName }, (res) => {
            if (res?.success && res?.content) {
              results[fileName] = res.content;
            } else {
              results[fileName] = ""; // Empty if file doesn't exist
            }
            resolve();
          });
        });
      }
      
      setConfig((prev) => ({
        ...prev,
        identityMd: results["IDENTITY.md"] || "",
        soulMd: results["SOUL.md"] || "",
        agentsMd: results["AGENTS.md"] || "",
        companyMembers: parseCompanyMembers(results["AGENTS.md"] || ""),
      }));
      setLoadingFiles(false);
    };
    
    loadFiles();
  }, [isOpen, agentId, socketRef]);

  // Parse company members from AGENTS.md
  const parseCompanyMembers = (agentsMd) => {
    // Extract agent IDs from lines like: "- researcher: description"
    const lines = agentsMd.split("\n");
    const members = [];
    for (const line of lines) {
      const match = line.match(/^-\s+([a-zA-Z0-9_-]+):/);
      if (match) members.push(match[1]);
    }
    return members;
  };

  const handleSave = useCallback(() => {
    if (!socketRef.current) return;
    
    // Generate AGENTS.md from company members
    let agentsMdContent = config.agentsMd;
    if (config.companyMembers.length > 0) {
      const memberLines = config.companyMembers.map(memberId => {
        const agent = availableAgents.find(a => a.id === memberId);
        const name = agent?.identity?.name || agent?.name || memberId;
        return `- ${memberId}: ${name}`;
      }).join("\n");
      
      agentsMdContent = `## Company\n\n${memberLines}\n`;
    }
    
    console.log("[AgentConfigModal] Saving config:", {
      agentId,
      agentToAgentEnabled: config.agentToAgentEnabled,
      companyMembers: config.companyMembers,
      toolsAllow: config.toolsAllow,
      toolsDeny: config.toolsDeny,
    });
    
    // Save agent config via config.patch (hot-reload)
    socketRef.current.emit(
      "agent:config:patch",
      {
        agentId,
        config: {
          model: config.model,
          thinking: config.thinking,
          workspace: config.workspace,
          identity: {
            name: config.identityName,
            emoji: config.identityEmoji,
            avatar: config.identityAvatar,
          },
          _9remote: {
            live2dModelId: config.live2dModelId,
            backgroundUrl: config.backgroundUrl,
            voiceId: config.voiceId,
            audioEnabled: config.audioEnabled,
          },
          agentToAgent: {
            enabled: config.agentToAgentEnabled,
            allow: config.companyMembers,
          },
          tools: {
            allow: config.toolsAllow,
            deny: config.toolsDeny,
          },
        },
      },
      () => {
        // After config saved, save workspace files
        const filesToSave = [];
        
        if (config.identityMd.trim()) {
          filesToSave.push({ fileName: "IDENTITY.md", content: config.identityMd });
        }
        
        if (config.soulMd.trim()) {
          filesToSave.push({ fileName: "SOUL.md", content: config.soulMd });
        }
        
        if (agentsMdContent.trim()) {
          filesToSave.push({ fileName: "AGENTS.md", content: agentsMdContent });
        }
        
        // Save files sequentially
        let savedCount = 0;
        const saveNext = () => {
          if (savedCount >= filesToSave.length) {
            onClose();
            return;
          }
          
          const file = filesToSave[savedCount];
          socketRef.current.emit(
            "agent:files:set",
            { agentId, fileName: file.fileName, content: file.content },
            () => {
              savedCount++;
              saveNext();
            }
          );
        };
        
        if (filesToSave.length > 0) {
          saveNext();
        } else {
          onClose();
        }
      }
    );
  }, [socketRef, agentId, config, onClose]);

  const set = (key) => (e) =>
    setConfig((prev) => ({ ...prev, [key]: e.target.value }));

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-dark-600 border border-dark-400 rounded-brand-lg shadow-2xl max-w-2xl w-full max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-dark-400 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">Agent Configuration</h3>
          <button onClick={onClose} className="text-gray-300 hover:text-white">✕</button>
        </div>

        {/* Tab switcher */}
        <div className="px-6 pt-4 flex gap-2">
          {["identity", "advanced"].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-1.5 rounded-brand text-sm font-medium transition-colors capitalize ${
                activeTab === tab
                  ? "bg-brand-600 text-white"
                  : "bg-dark-500 text-dark-200 hover:bg-dark-400"
              }`}
            >
              {tab === "identity" ? "Identity" : "Advanced"}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="px-6 py-4 overflow-y-auto flex-1">
          {loading ? (
            <div className="py-8 text-center text-dark-200">Loading...</div>
          ) : activeTab === "identity" ? (
            <div className="space-y-3">
              <Field label="Name">
                <input
                  type="text"
                  value={config.identityName}
                  onChange={set("identityName")}
                  placeholder="Agent name"
                  className={inputCls}
                />
              </Field>
              <Field label="Emoji">
                <input
                  type="text"
                  value={config.identityEmoji}
                  onChange={set("identityEmoji")}
                  placeholder="🤖"
                  className={inputCls}
                />
              </Field>
              <Field label="Avatar URL">
                <input
                  type="text"
                  value={config.identityAvatar}
                  onChange={set("identityAvatar")}
                  placeholder="https://..."
                  className={inputCls}
                />
              </Field>
              <Field label="Workspace Path">
                <input
                  type="text"
                  value={config.workspace}
                  onChange={set("workspace")}
                  placeholder="/path/to/workspace"
                  className={inputCls}
                />
              </Field>
              <Field label="Live2D Model">
                <select value={config.live2dModelId} onChange={set("live2dModelId")} className={inputCls}>
                  {LIVE2D_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.category})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Background URL">
                <input
                  type="text"
                  value={config.backgroundUrl}
                  onChange={set("backgroundUrl")}
                  placeholder="https://..."
                  className={inputCls}
                />
              </Field>
              <Field label="Voice">
                <select value={config.voiceId} onChange={set("voiceId")} className={inputCls}>
                  {Object.entries(VOICES).map(([id, name]) => (
                    <option key={id} value={id}>{name}</option>
                  ))}
                </select>
              </Field>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={config.audioEnabled}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, audioEnabled: e.target.checked }))
                  }
                  className="w-4 h-4"
                />
                <label className="text-xs text-dark-200 mb-1">Enable TTS Audio</label>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <Field label="Model">
                <select value={config.model} onChange={set("model")} className={inputCls}>
                  <option value="">-- Select Model --</option>
                  {modelsList.map((m) => (
                    <option key={m.id} value={m.id}>
                      [{m.provider}] {m.name || m.id}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Thinking Mode">
                <select value={config.thinking} onChange={set("thinking")} className={inputCls}>
                  {THINKING_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              </Field>
              
              <Field label="IDENTITY.md">
                {loadingFiles ? (
                  <div className="text-xs text-dark-300 italic">Loading...</div>
                ) : (
                  <textarea
                    value={config.identityMd}
                    onChange={(e) => setConfig((prev) => ({ ...prev, identityMd: e.target.value }))}
                    placeholder="- **Name:** Agent Name&#10;- **Emoji:** 🤖&#10;- **Avatar:** path/to/avatar.png"
                    rows={6}
                    className={inputCls + " font-mono text-xs"}
                  />
                )}
              </Field>
              
              <Field label="SOUL.md">
                {loadingFiles ? (
                  <div className="text-xs text-dark-300 italic">Loading...</div>
                ) : (
                  <textarea
                    value={config.soulMd}
                    onChange={(e) => setConfig((prev) => ({ ...prev, soulMd: e.target.value }))}
                    placeholder="# You are...&#10;&#10;## Core principles&#10;- Be helpful&#10;- Be concise"
                    rows={10}
                    className={inputCls + " font-mono text-xs"}
                  />
                )}
              </Field>
              
              <Field label="Company Members">
                {loadingFiles ? (
                  <div className="text-xs text-dark-300 italic">Loading...</div>
                ) : (
                  <>
                    <select
                      multiple
                      value={config.companyMembers}
                      onChange={(e) => {
                        const selected = Array.from(e.target.selectedOptions, opt => opt.value);
                        setConfig((prev) => ({ ...prev, companyMembers: selected }));
                      }}
                      className={inputCls + " h-32"}
                    >
                      {availableAgents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.identity?.emoji || agent.emoji || "🤖"} {agent.identity?.name || agent.name}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-dark-300 mt-1">
                      Hold Cmd/Ctrl to select multiple. Agent có thể spawn các members này.
                    </p>
                  </>
                )}
              </Field>
              
              <Field label="Agent-to-Agent Interaction">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={config.agentToAgentEnabled}
                    onChange={(e) => setConfig((prev) => ({ ...prev, agentToAgentEnabled: e.target.checked }))}
                    className="w-4 h-4"
                  />
                  <label className="text-xs text-dark-200">
                    Enable agent có thể gọi các company members
                  </label>
                </div>
              </Field>
              
              <Field label="Tools - Allow">
                <select
                  multiple
                  value={config.toolsAllow}
                  onChange={(e) => {
                    const selected = Array.from(e.target.selectedOptions, opt => opt.value);
                    setConfig((prev) => ({ ...prev, toolsAllow: selected }));
                  }}
                  className={inputCls + " h-24"}
                >
                  {AVAILABLE_TOOLS.map((tool) => (
                    <option key={tool} value={tool}>{tool}</option>
                  ))}
                </select>
                <p className="text-xs text-dark-300 mt-1">
                  Tools được phép sử dụng (empty = all allowed)
                </p>
              </Field>
              
              <Field label="Tools - Deny">
                <select
                  multiple
                  value={config.toolsDeny}
                  onChange={(e) => {
                    const selected = Array.from(e.target.selectedOptions, opt => opt.value);
                    setConfig((prev) => ({ ...prev, toolsDeny: selected }));
                  }}
                  className={inputCls + " h-24"}
                >
                  {AVAILABLE_TOOLS.map((tool) => (
                    <option key={tool} value={tool}>{tool}</option>
                  ))}
                </select>
                <p className="text-xs text-dark-300 mt-1">
                  Tools bị cấm sử dụng
                </p>
              </Field>
              
              <Field label="Skills">
                <p className="text-xs text-dark-200">
                  Quản lý skills qua{" "}
                  <a
                    href="https://clawhub.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand-400 hover:underline"
                  >
                    ClawHub
                  </a>
                </p>
              </Field>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-dark-400 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-dark-500 hover:bg-dark-400 border border-dark-400 hover:border-brand-500 text-white rounded-brand text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={loading}
            className="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-brand text-sm transition-colors disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full bg-dark-500 text-white border border-dark-400 rounded-brand px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 outline-none";

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs text-dark-200 mb-1">{label}</label>
      {children}
    </div>
  );
}
