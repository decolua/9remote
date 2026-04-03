"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useOpenClaw } from "@/features/openclaw/hooks/useOpenClaw";
import { useOpenClawStore } from "@/shared/stores/openclawStore";
import Live2DViewer from "@/shared/components/Live2DViewer";
import { FileUploadButton } from "@/shared/components/FileUpload";
import AgentConfigModal from "@/features/openclaw/components/AgentConfigModal";
import AgentView from "@/features/openclaw/components/AgentView";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const live2dCanvasRef = { current: null };

const SLASH_COMMANDS = [
  { cmd: "/reset", desc: "Xóa context, session mới" },
  { cmd: "/think high", desc: "Tăng mức thinking" },
  { cmd: "/think off", desc: "Tắt thinking" },
  { cmd: "/model", desc: "Xem/đổi model" },
  { cmd: "/status", desc: "Trạng thái hệ thống" },
  { cmd: "/stop", desc: "Dừng response" },
  { cmd: "/context", desc: "Xem kích thước context" },
  { cmd: "/compact", desc: "Compact context" },
  { cmd: "/usage tokens", desc: "Hiện token usage" },
  { cmd: "/verbose on", desc: "Bật verbose" },
  { cmd: "/subagents list", desc: "Xem subagents" },
  { cmd: "/help", desc: "Hiện help" },
];

function toText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => c?.text ?? "").join("");
  return String(content);
}

function isVisibleMessage(msg) {
  if (!msg) return false;
  if (msg.role !== "user" && msg.role !== "assistant") return false;
  return toText(msg.content).trim().length > 0;
}

function MarkdownContent({ content }) {
  const text = toText(content);
  if (!text) return null;
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <div className="mb-1 last:mb-0">{children}</div>,
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        code: ({ inline, children }) =>
          inline
            ? <code className="bg-black/30 px-1 py-0.5 rounded text-xs font-mono">{children}</code>
            : <pre className="bg-black/40 rounded p-2 mt-1 overflow-x-auto text-xs font-mono whitespace-pre-wrap"><code>{children}</code></pre>,
        ul: ({ children }) => <ul className="list-disc list-inside mb-1 space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside mb-1 space-y-0.5">{children}</ol>,
        li: ({ children }) => <li className="text-sm">{children}</li>,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="underline opacity-80 hover:opacity-100">{children}</a>,
        blockquote: ({ children }) => <blockquote className="border-l-2 border-white/30 pl-2 opacity-80 italic">{children}</blockquote>,
        h1: ({ children }) => <h1 className="text-base font-bold mb-1">{children}</h1>,
        h2: ({ children }) => <h2 className="text-sm font-bold mb-1">{children}</h2>,
        h3: ({ children }) => <h3 className="text-sm font-semibold mb-1">{children}</h3>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function detectEmotion(text) {
  const lower = text.toLowerCase();
  if (/(vui|haha|😊|😄|🎉|tuyệt|hay quá)/i.test(lower)) return "happy";
  if (/(buồn|😢|😭|tiếc|đáng buồn)/i.test(lower)) return "sad";
  if (/(wow|ồ|😮|bất ngờ|không ngờ)/i.test(lower)) return "surprised";
  if (/(hmm|suy nghĩ|🤔|để xem)/i.test(lower)) return "thinking";
  return "idle";
}

function ChatView({ socketRef, connected }) {
  const openclawHook = useOpenClaw(socketRef);
  const { sendMessage, abortMessage, loadHistory } = openclawHook;
  const {
    isOpen, agents, activeAgentId,
    isStreaming, streamingText,
    currentAudio, setCurrentAudio,
    pendingFiles, setPendingFiles, clearPendingFiles,
    agentProgress,
    configModalOpen, configModalAgentId, openConfigModal, closeConfigModal,
    getSessionKey, getMessages, isAudioEnabled, setAudioEnabled,
    backToAgents,
  } = useOpenClawStore();

  const [input, setInput] = useState("");
  const [emotion, setEmotion] = useState("idle");
  const [showSlash, setShowSlash] = useState(false);

  const messagesEndRef = useRef(null);
  const audioRef = useRef(null);
  const slashRef = useRef(null);

  const sessionKey = getSessionKey(activeAgentId);
  const messages = getMessages(sessionKey);
  const currentAgent = agents.find((a) => a.id === activeAgentId);
  const progress = agentProgress[activeAgentId];
  const agentName = currentAgent?.identity?.name || currentAgent?.name || "Main";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  useEffect(() => {
    if (isOpen && connected) loadHistory(activeAgentId);
  }, [isOpen, activeAgentId, connected]);

  useEffect(() => {
    if (streamingText) {
      const detected = detectEmotion(streamingText);
      if (detected !== emotion) setEmotion(detected);
    }
  }, [streamingText]);

  useEffect(() => {
    if (!currentAudio || !isAudioEnabled(activeAgentId)) return;
    const playAudio = async () => {
      try {
        const dataUri = `data:audio/${currentAudio.format};base64,${currentAudio.audio}`;
        const live2dModel = live2dCanvasRef.current?._live2dModel || null;
        if (live2dModel?.startLipSyncFromBase64Audio) {
          await live2dModel.startLipSyncFromBase64Audio(dataUri);
          setCurrentAudio(null);
        } else {
          const audioBlob = new Blob(
            [Uint8Array.from(atob(currentAudio.audio), (c) => c.charCodeAt(0))],
            { type: `audio/${currentAudio.format}` }
          );
          const audioUrl = URL.createObjectURL(audioBlob);
          if (audioRef.current) {
            audioRef.current.src = audioUrl;
            audioRef.current.play();
            audioRef.current.onended = () => {
              URL.revokeObjectURL(audioUrl);
              setCurrentAudio(null);
            };
          }
        }
      } catch (err) {
        console.error("[OpenClaw] Audio playback failed:", err);
      }
    };
    playAudio();
  }, [currentAudio, activeAgentId]);

  // Close slash popup on outside click
  useEffect(() => {
    if (!showSlash) return;
    const handler = (e) => {
      if (slashRef.current && !slashRef.current.contains(e.target)) setShowSlash(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showSlash]);

  const handleSend = useCallback((e) => {
    e.preventDefault();
    if (!input.trim() || isStreaming || !connected) return;
    const attachments = pendingFiles?.length
      ? pendingFiles.map((f) => ({ type: f.type, mimeType: f.mimeType, fileName: f.fileName, content: f.content }))
      : undefined;
    sendMessage(activeAgentId, input.trim(), attachments);
    setInput("");
    clearPendingFiles();
  }, [input, isStreaming, connected, activeAgentId, pendingFiles, sendMessage, clearPendingFiles]);

  const handleAbort = useCallback(() => abortMessage(activeAgentId), [activeAgentId, abortMessage]);

  const handleClearChat = useCallback(() => {
    if (!connected || isStreaming) return;
    sendMessage(activeAgentId, "/reset");
  }, [connected, isStreaming, activeAgentId, sendMessage]);

  const handleToggleAudio = useCallback(() => {
    setAudioEnabled(activeAgentId, !isAudioEnabled(activeAgentId));
  }, [activeAgentId, isAudioEnabled, setAudioEnabled]);

  const handleSlashSelect = useCallback((cmd) => {
    setInput(cmd);
    setShowSlash(false);
  }, []);

  return (
    <>
      <div className="fixed inset-0 z-50 flex flex-col bg-dark-800 dot-grid-bg">

        {/* Header — always at top, never absolute */}
        <div className="flex-shrink-0 flex items-center justify-between px-3 py-2 bg-dark-600 border-b border-dark-400 z-10">
          <button
            onClick={backToAgents}
            className="w-8 h-8 flex items-center justify-center rounded-brand bg-dark-500 hover:bg-dark-400 border border-dark-400 hover:border-brand-500 text-white transition"
            title="Quay lại"
          >
            {/* Back arrow */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M19 12H5M12 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <span className="text-white text-sm font-semibold truncate max-w-[40%]">{agentName}</span>
          <div className="flex items-center gap-1">
            <button
              onClick={handleToggleAudio}
              className={`w-8 h-8 flex items-center justify-center rounded-brand border transition ${
                isAudioEnabled(activeAgentId)
                  ? "bg-brand-500/20 border-brand-500 text-brand-400"
                  : "bg-dark-500 border-dark-400 hover:border-brand-500 text-white"
              }`}
              title="Toggle audio"
            >
              {/* Volume icon */}
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <path d="M11 5L6 9H2v6h4l5 4V5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            <button
              onClick={handleClearChat}
              className="w-8 h-8 flex items-center justify-center rounded-brand bg-dark-500 hover:bg-dark-400 border border-dark-400 hover:border-brand-500 text-white transition"
              title="Xóa chat"
            >
              {/* Trash icon */}
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            {currentAgent && (
              <button
                onClick={() => openConfigModal(activeAgentId)}
                className="w-8 h-8 flex items-center justify-center rounded-brand bg-dark-500 hover:bg-dark-400 border border-dark-400 hover:border-brand-500 text-white transition"
                  title="Cài đặt"
              >
                {/* Settings icon */}
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2"/>
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Main content below header */}
        <div className="flex-1 flex overflow-hidden relative">

          {/* Avatar — fullscreen on mobile, fixed column on desktop */}
          <div className="absolute inset-0 md:relative md:inset-auto md:w-[420px] md:flex-shrink-0 md:border-r md:border-dark-400 bg-dark-900">
            <Live2DViewer
              modelName={currentAgent?._9remote?.live2dModelId || "25meiko_collabo01_t02"}
              emotion={emotion}
              canvasRef={live2dCanvasRef}
              className="w-full h-full"
            />
            {progress?.running && (
              <div className="absolute top-3 left-3 bg-black/70 backdrop-blur-sm text-white px-2 py-1.5 rounded-lg text-xs border border-white/20 z-10 max-w-[200px]">
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Đang xử lý...</span>
                </div>
                {progress.subagents?.length > 0 && (
                  <div className="mt-1.5 space-y-0.5">
                    <div className="text-[10px] text-gray-300 font-medium">Active subagents:</div>
                    {progress.subagents.map((sub, idx) => (
                      <div key={idx} className="text-[10px] text-brand-300 flex items-center gap-1">
                        <span className="w-1 h-1 bg-brand-400 rounded-full animate-pulse" />
                        {sub.agentId || sub.id || `Agent ${idx + 1}`}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Chat panel — overlay bottom on mobile, flex column on desktop */}
          <div className="absolute bottom-0 left-0 right-0 z-20 md:relative md:bottom-auto md:left-auto md:right-auto md:z-auto md:flex-1 md:flex md:flex-col md:bg-dark-700">

            {/* Messages */}
            <div
              className="h-[65vh] overflow-y-auto flex flex-col px-3 pb-1 md:h-auto md:flex-1 md:p-4"
              style={{
                maskImage: "linear-gradient(to bottom, transparent 0%, black 25%)",
                WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 25%)",
              }}
            >
              <div className="flex flex-col gap-2 mt-auto">
                {messages.filter(isVisibleMessage).map((msg, i) => {
                  // Check if this is a subagent spawn/interaction message
                  const isSubagentSpawn = msg.role === "tool" && msg.content?.includes?.("sessions_spawn");
                  const isSubagentSend = msg.role === "tool" && msg.content?.includes?.("sessions_send");
                  
                  if (isSubagentSpawn || isSubagentSend) {
                    // Parse subagent info
                    let subagentInfo = null;
                    try {
                      const parsed = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content;
                      subagentInfo = {
                        agentId: parsed.agentId || parsed.agent,
                        action: isSubagentSpawn ? "spawn" : "send",
                        message: parsed.message || parsed.prompt,
                      };
                    } catch (e) {
                      // Ignore parse errors
                    }
                    
                    if (subagentInfo) {
                      return (
                        <div key={msg.id ?? i} className="flex justify-center">
                          <div className="max-w-[88%] px-3 py-2 rounded-brand text-xs bg-brand-500/10 border border-brand-500/30 text-brand-300">
                            <div className="flex items-center gap-2">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                                <path d="M12 2L2 7l10 5 10-5-10-5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                <path d="M2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                              <span className="font-medium">
                                {subagentInfo.action === "spawn" ? "🚀 Spawned" : "📤 Sent to"} agent: {subagentInfo.agentId}
                              </span>
                            </div>
                            {subagentInfo.message && (
                              <div className="mt-1 text-[10px] text-dark-200 italic truncate">
                                "{subagentInfo.message.slice(0, 60)}..."
                              </div>
                            )}
                            <div className="text-[10px] opacity-40 mt-1">
                              {new Date(msg.timestamp).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}
                            </div>
                          </div>
                        </div>
                      );
                    }
                  }
                  
                  return (
                    <div key={msg.id ?? i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                      <div style={{ overflowWrap: "anywhere" }} className={`max-w-[88%] px-3 py-2 rounded-brand text-sm leading-relaxed break-words ${
                        msg.role === "user"
                          ? "bg-brand-600 text-white"
                          : "bg-dark-500 border border-dark-400 text-dark-50"
                      }`}>
                        <MarkdownContent content={msg.content} />
                        <div className="text-[10px] opacity-40 mt-1">
                          {new Date(msg.timestamp).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}
                        </div>
                      </div>
                    </div>
                  );
                })}

                {isStreaming && (
                  <div className="flex justify-start">
                    <div style={{ overflowWrap: "anywhere" }} className="max-w-[88%] px-3 py-2 rounded-brand text-sm bg-dark-500 border border-dark-400 text-dark-50 break-words">
                      {streamingText ? <MarkdownContent content={streamingText} /> : (
                        <div className="flex gap-1 items-center py-1">
                          <span className="w-1.5 h-1.5 bg-gray-300 rounded-full animate-bounce" />
                          <span className="w-1.5 h-1.5 bg-gray-300 rounded-full animate-bounce [animation-delay:100ms]" />
                          <span className="w-1.5 h-1.5 bg-gray-300 rounded-full animate-bounce [animation-delay:200ms]" />
                        </div>
                      )}
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>

            {/* Pending file previews */}
            {Array.isArray(pendingFiles) && pendingFiles.length > 0 && (
              <div className="flex gap-2 px-3 pb-1 overflow-x-auto bg-dark-600 border-t border-dark-400">
                {pendingFiles.map((f, i) => (
                  <div key={i} className="relative flex-shrink-0">
                    {f.preview
                      ? <img src={f.preview} alt={f.fileName} className="w-12 h-12 object-cover rounded-lg border border-white/20" />
                      : <div className="w-12 h-12 flex items-center justify-center bg-white/10 rounded-lg border border-white/20 text-xl">📄</div>
                    }
                    <button
                      onClick={() => setPendingFiles(pendingFiles.filter((_, j) => j !== i))}
                      className="absolute -top-1 -right-1 w-4 h-4 bg-red-600 text-white rounded-full text-[10px] flex items-center justify-center"
                    >✕</button>
                  </div>
                ))}
              </div>
            )}

            {/* Input bar */}
            <form
              onSubmit={handleSend}
              className="flex items-center gap-2 px-3 py-2 bg-dark-600 border-t border-dark-400"
            >
              {/* Slash commands button */}
              <div className="relative flex-shrink-0" ref={slashRef}>
                <button
                  type="button"
                  onClick={() => setShowSlash((v) => !v)}
                  disabled={!connected || isStreaming}
                  className="w-8 h-8 flex items-center justify-center rounded-brand bg-dark-500 hover:bg-dark-400 border border-dark-400 hover:border-brand-500 text-white text-sm transition disabled:opacity-40"
                  title="Slash commands"
                >
                  /
                </button>
                {showSlash && (
                  <div className="absolute bottom-10 left-0 z-50 w-64 bg-dark-600 border border-dark-400 rounded-brand-lg overflow-hidden shadow-xl">
                    {SLASH_COMMANDS.map(({ cmd, desc }) => (
                      <button
                        key={cmd}
                        type="button"
                        onClick={() => handleSlashSelect(cmd)}
                        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-dark-500 text-left transition"
                      >
                        <span className="text-brand-400 text-xs font-mono whitespace-nowrap">{cmd}</span>
                        <span className="text-dark-200 text-xs truncate">{desc}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <FileUploadButton
                onFilesReady={(files) => setPendingFiles((prev) => [...(Array.isArray(prev) ? prev : []), ...files])}
                disabled={!connected || isStreaming}
                pendingCount={pendingFiles.length}
              />
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={connected ? "Nhập tin nhắn..." : "Đang kết nối..."}
                disabled={!connected || isStreaming}
                style={{ fontSize: "16px" }}
                className="flex-1 bg-dark-500 text-white placeholder-dark-200 rounded-brand px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500 border border-dark-400 disabled:opacity-50 min-w-0"
              />
              {isStreaming ? (
                <button type="button" onClick={handleAbort}
                  className="flex-shrink-0 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-brand text-sm transition-colors"
                >⏹</button>
              ) : (
                <button type="submit" disabled={!input.trim() || !connected}
                  className="flex-shrink-0 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-brand text-sm transition-all disabled:opacity-40"
                >Gửi</button>
              )}
            </form>
          </div>
        </div>
      </div>

      {/* Config Modal */}
      <AgentConfigModal
        isOpen={configModalOpen}
        onClose={closeConfigModal}
        agentId={configModalAgentId}
        socketRef={socketRef}
      />

      {/* Hidden audio element */}
      <audio ref={audioRef} style={{ display: "none" }} />
    </>
  );
}

export default function OpenClawChat({ onClose, socketRef, connected }) {
  const { chatView } = useOpenClawStore();
  
  return (
    <div className="fixed inset-0 z-50">
      {/* AgentView — conditional render */}
      {chatView === "agents" && (
        <div className="absolute inset-0 z-10 animate-in fade-in duration-300">
          <AgentView onClose={onClose} socketRef={socketRef} connected={connected} />
        </div>
      )}
      
      {/* ChatView — conditional render, slides in from right */}
      {chatView === "chat" && (
        <div className="absolute inset-0 z-20 animate-in slide-in-from-right duration-300">
          <ChatView socketRef={socketRef} connected={connected} />
        </div>
      )}
    </div>
  );
}
