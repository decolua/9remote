// test-opencode-web/src/App.jsx
import React, { useState, useEffect } from "react";
import { Header } from "./components/Header.jsx";
import { ChatTimeline } from "./components/ChatTimeline.jsx";
import { TerminalView } from "./components/TerminalView.jsx";
import { PromptInput } from "./components/input/PromptInput.jsx";
import { StatusBar } from "./components/StatusBar.jsx";
import { ModelModal } from "./components/modals/ModelModal.jsx";
import { McpModal } from "./components/modals/McpModal.jsx";
import { DoctorModal } from "./components/modals/DoctorModal.jsx";
import { SessionsModal } from "./components/modals/SessionsModal.jsx";
import { BUILTIN_COMMANDS } from "./components/input/commandRegistry.js";

export function App() {
  const [viewMode, setViewMode] = useState("split"); // 'ui' | 'split' | 'terminal'
  const [status, setStatus] = useState("idle");
  const [messages, setMessages] = useState([]);
  const [ansiStream, setAnsiStream] = useState([]);
  const [activeModal, setActiveModal] = useState(null); // 'model' | 'mcp' | 'doctor' | 'resume'

  const [gitBranch, setGitBranch] = useState("main");
  const [metadata, setMetadata] = useState({
    model: "opencode/big-pickle",
    sessionId: "",
    mcpServers: [],
  });
  const [stats, setStats] = useState({
    inputTokens: 0,
    outputTokens: 0,
    totalTurns: 0,
  });

  const isTurnRunning = status === "busy";

  // Global Keybindings: Ctrl + ~ (view), Esc (close modal), Ctrl + K (focus input)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "`" || e.key === "~")) {
        e.preventDefault();
        setViewMode((curr) => (curr === "ui" ? "split" : curr === "split" ? "terminal" : "ui"));
        return;
      }
      if (e.key === "Escape") {
        setActiveModal(null);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const textarea = document.querySelector("textarea");
        textarea?.focus();
        return;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Listen to Global SSE events
  useEffect(() => {
    const es = new EventSource("/api/events");

    es.addEventListener("ansi", (e) => {
      try {
        const { chunk } = JSON.parse(e.data);
        setAnsiStream((prev) => [...prev, chunk]);
      } catch {}
    });

    es.addEventListener("delta", (e) => {
      try {
        const { text } = JSON.parse(e.data);
        setMessages((prev) => {
          const list = [...prev];
          const last = list[list.length - 1];
          if (last && last.role === "assistant") {
            last.text = (last.text || "") + text;
            return [...list];
          }
          return [...list, { role: "assistant", text }];
        });
      } catch {}
    });

    es.addEventListener("thinking", (e) => {
      try {
        const { text } = JSON.parse(e.data);
        setMessages((prev) => {
          const list = [...prev];
          const last = list[list.length - 1];
          if (last && last.role === "assistant") {
            last.thinking = (last.thinking || "") + text;
            return [...list];
          }
          return [...list, { role: "assistant", thinking: text }];
        });
      } catch {}
    });

    es.addEventListener("tool_call", (e) => {
      try {
        const data = JSON.parse(e.data);
        setMessages((prev) => {
          const list = [...prev];
          const last = list[list.length - 1];
          if (last && last.role === "assistant") {
            last.tools = [...(last.tools || []), data];
            return [...list];
          }
          return [...list, { role: "assistant", tools: [data] }];
        });
      } catch {}
    });

    es.addEventListener("tool_result", (e) => {
      try {
        const data = JSON.parse(e.data);
        setMessages((prev) => {
          const list = [...prev];
          for (let i = list.length - 1; i >= 0; i--) {
            const tools = list[i].tools || [];
            const target = tools.find((t) => t.id === data.id);
            if (target) {
              target.result = data;
              return [...list];
            }
          }
          return list;
        });
      } catch {}
    });

    es.addEventListener("init", (e) => {
      try {
        const data = JSON.parse(e.data);
        setMetadata(data);
      } catch {}
    });

    es.addEventListener("git_branch", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.branch) setGitBranch(data.branch);
      } catch {}
    });

    es.addEventListener("conversation_reset", () => {
      setMessages([]);
      setAnsiStream([]);
    });

    es.addEventListener("done", (e) => {
      setStatus("idle");
      try {
        const data = JSON.parse(e.data);
        if (data.stats) setStats(data.stats);
      } catch {}
    });

    return () => es.close();
  }, []);

  const sendChatMessage = async (text) => {
    if (!text) return;
    setStatus("busy");
    setMessages((prev) => [...prev, { role: "user", text }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setStatus("idle");
        setMessages((prev) => [
          ...prev,
          { role: "assistant", text: `⚠️ ${data.error || "Không thể gửi yêu cầu tới OpenCode."}` },
        ]);
      }
    } catch (err) {
      setStatus("idle");
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: `❌ Lỗi gửi yêu cầu: ${err.message}` },
      ]);
    }
  };

  const handleRunShell = async (command) => {
    setMessages((prev) => [...prev, { role: "user", text: `! ${command}` }]);
    try {
      const res = await fetch("/api/shell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      });
      const data = await res.json();
      const output = data.stdout || data.stderr || "Lệnh thực thi xong (không có output).";
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `\`\`\`bash\n$ ${command}\n\n${output}\n\`\`\``,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: `❌ Lỗi thực thi shell: ${err.message}` },
      ]);
    }
  };

  const handleApplyModel = async (model, variant) => {
    await fetch("/api/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, variant }),
    });
    setMetadata((prev) => ({ ...prev, model }));
  };

  const handleResumeSession = async (sessionId) => {
    setMessages([]);
    await fetch("/api/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
  };

  const handleReset = async () => {
    setMessages([]);
    await fetch("/api/reset", { method: "POST" });
  };

  const handleStop = async () => {
    await fetch("/api/stop", { method: "POST" });
    setStatus("idle");
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-[#07090e] text-slate-100 overflow-hidden font-sans">
      <Header
        status={status}
        viewMode={viewMode}
        onViewChange={setViewMode}
        onReset={handleReset}
        onOpenModal={setActiveModal}
      />

      {/* Main Dual-View Workspace */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Side: Rich Chat UI */}
        {(viewMode === "ui" || viewMode === "split") && (
          <div className={`flex flex-col h-full overflow-hidden ${viewMode === "split" ? "w-1/2 border-r border-white/10" : "w-full"}`}>
            <ChatTimeline
              messages={messages}
              isTurnRunning={isTurnRunning}
            />

            <PromptInput
              isTurnRunning={isTurnRunning}
              onSend={sendChatMessage}
              onRunShell={handleRunShell}
              onStop={handleStop}
              availableSlashCommands={BUILTIN_COMMANDS.map((c) => c.name.slice(1))}
              onOpenModal={setActiveModal}
            />
          </div>
        )}

        {/* Right Side: Terminal View */}
        {(viewMode === "terminal" || viewMode === "split") && (
          <div className={viewMode === "split" ? "w-1/2 h-full" : "w-full h-full"}>
            <TerminalView ansiStream={ansiStream} />
          </div>
        )}
      </div>

      {/* Bottom Status Bar */}
      <StatusBar
        branch={gitBranch}
        model={metadata.model}
        stats={stats}
        sessionId={metadata.sessionId}
        onOpenModal={setActiveModal}
      />

      {/* Modals */}
      {activeModal === "model" && (
        <ModelModal
          currentModel={metadata.model}
          onClose={() => setActiveModal(null)}
          onApply={handleApplyModel}
        />
      )}

      {activeModal === "mcp" && (
        <McpModal
          mcpServers={metadata.mcpServers || []}
          onClose={() => setActiveModal(null)}
        />
      )}

      {activeModal === "doctor" && (
        <DoctorModal
          onClose={() => setActiveModal(null)}
        />
      )}

      {activeModal === "resume" && (
        <SessionsModal
          onClose={() => setActiveModal(null)}
          onResumeSession={handleResumeSession}
        />
      )}
    </div>
  );
}
