// test-claude-web/src/App.jsx
import React, { useState, useEffect } from "react";
import { Header } from "./components/Header.jsx";
import { TaskBar } from "./components/TaskBar.jsx";
import { ChatTimeline } from "./components/ChatTimeline.jsx";
import { TerminalView } from "./components/TerminalView.jsx";
import { PermissionModal } from "./components/PermissionModal.jsx";
import { PromptInput } from "./components/input/PromptInput.jsx";
import { StatusBar } from "./components/StatusBar.jsx";
import { ModelModal } from "./components/modals/ModelModal.jsx";
import { ConfigModal } from "./components/modals/ConfigModal.jsx";
import { McpModal } from "./components/modals/McpModal.jsx";
import { SessionsModal } from "./components/modals/SessionsModal.jsx";
import { TasksModal } from "./components/modals/TasksModal.jsx";
import { DoctorModal } from "./components/modals/DoctorModal.jsx";

export function App() {
  const [viewMode, setViewMode] = useState("split"); // 'ui' | 'split' | 'terminal'
  const [status, setStatus] = useState("idle");
  const [permissionMode, setPermissionMode] = useState("default");
  const [messages, setMessages] = useState([]);
  const [ansiStream, setAnsiStream] = useState([]);
  const [tasks, setTasks] = useState(new Map());
  const [isPlanMode, setIsPlanMode] = useState(false);
  const [activeQuestion, setActiveQuestion] = useState(null);
  const [activePermission, setActivePermission] = useState(null);
  const [activeModal, setActiveModal] = useState(null); // 'model' | 'config' | 'mcp' | 'resume'

  // CLI metadata & stats
  const [gitBranch, setGitBranch] = useState("main");
  const [metadata, setMetadata] = useState({
    model: "sonnet",
    sessionId: "",
    tools: [],
    skills: [],
    slashCommands: [],
    mcpServers: [],
  });
  const [stats, setStats] = useState({
    totalCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  const [suggestions, setSuggestions] = useState([]);

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

  // Listen to Global SSE events (Terminal + Protocol)
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
        if (data.name === "EnterPlanMode") setIsPlanMode(true);
        if (data.name === "ExitPlanMode") setIsPlanMode(false);
        if (data.name.startsWith("Task") && data.input?.subject) {
          setTasks((prev) => {
            const next = new Map(prev);
            next.set(data.input.taskId || data.id, {
              subject: data.input.subject,
              status: data.input.status || "pending",
              activeForm: data.input.activeForm,
            });
            return next;
          });
        }

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

    es.addEventListener("permission_request", (e) => {
      try {
        const data = JSON.parse(e.data);
        setActivePermission(data);
      } catch {}
    });

    es.addEventListener("ask_user_question", (e) => {
      try {
        const data = JSON.parse(e.data);
        setActiveQuestion(data);
      } catch {}
    });

    es.addEventListener("prompt_suggestion", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.suggestion) {
          setSuggestions((prev) => [data.suggestion, ...prev.filter((s) => s !== data.suggestion)].slice(0, 4));
        }
      } catch {}
    });

    es.addEventListener("done", (e) => {
      setStatus("idle");
      try {
        const data = JSON.parse(e.data);
        if (data.stats) setStats(data.stats);
      } catch {}
    });

    es.addEventListener("init", (e) => {
      try {
        const data = JSON.parse(e.data);
        setMetadata(data);
        if (data.permissionMode) setPermissionMode(data.permissionMode);
      } catch {}
    });

    es.addEventListener("conversation_reset", () => {
      setMessages([]);
      setTasks(new Map());
      setIsPlanMode(false);
      setActiveQuestion(null);
      setActivePermission(null);
      setAnsiStream([]);
    });

    es.addEventListener("compact", (e) => {
      setMessages((prev) => [
        ...prev,
        { role: "system", text: "🗜️ Ngữ cảnh cuộc trò chuyện đã được nén thành công (Compact Conversation)." },
      ]);
    });

    es.addEventListener("git_branch", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.branch) setGitBranch(data.branch);
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
          { role: "assistant", text: `⚠️ ${data.error || "Không thể gửi yêu cầu."}` },
        ]);
      }
    } catch (err) {
      setStatus("idle");
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: `❌ Lỗi gửi chat: ${err.message}` },
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

  const handleDecision = async (requestId, behavior) => {
    setActivePermission(null);
    await fetch("/api/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, behavior }),
    });
  };

  const handleAnswerQuestion = async (requestId, answers) => {
    setActiveQuestion(null);
    await fetch("/api/answer_question", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, answers }),
    });
  };

  const handleModeChange = async (mode) => {
    setPermissionMode(mode);
    await fetch("/api/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
  };

  const handleReset = async () => {
    if (!confirm("Bắt đầu phiên Claude mới?")) return;
    setMessages([]);
    setTasks(new Map());
    setIsPlanMode(false);
    setActiveQuestion(null);
    setActivePermission(null);
    await fetch("/api/reset", { method: "POST" });
  };

  const handleStop = async () => {
    await fetch("/api/stop", { method: "POST" });
    setStatus("idle");
  };

  const handleApplyModel = async (model, effort) => {
    await sendChatMessage(`/model ${model}`);
    if (effort) {
      await sendChatMessage(`/effort ${effort}`);
    }
  };

  const handleApplyConfig = async (cmdList) => {
    await sendChatMessage(`/config ${cmdList}`);
  };

  const handleResumeSession = async (sessionId) => {
    setMessages([]);
    setTasks(new Map());
    setIsPlanMode(false);
    await fetch("/api/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-[#07090e] text-slate-100 overflow-hidden font-sans">
      <Header
        status={status}
        viewMode={viewMode}
        onViewChange={setViewMode}
        permissionMode={permissionMode}
        onModeChange={handleModeChange}
        onReset={handleReset}
        onOpenModal={setActiveModal}
      />

      <TaskBar tasks={tasks} isPlanMode={isPlanMode} />

      {/* Main Dual-View Workspace */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Side: Rich Chat UI */}
        {(viewMode === "ui" || viewMode === "split") && (
          <div className={`flex flex-col h-full overflow-hidden ${viewMode === "split" ? "w-1/2 border-r border-white/10" : "w-full"}`}>
            <ChatTimeline
              messages={messages}
              activeQuestion={activeQuestion}
              onAnswerQuestion={handleAnswerQuestion}
              isTurnRunning={isTurnRunning}
            />

            {/* Comprehensive Input with Autocomplete, History & File Mentions */}
            <PromptInput
              isTurnRunning={isTurnRunning}
              onSend={sendChatMessage}
              onRunShell={handleRunShell}
              onStop={handleStop}
              availableSkills={metadata.skills || []}
              availableSlashCommands={metadata.slashCommands || []}
              suggestions={suggestions}
              onOpenModal={setActiveModal}
            />
          </div>
        )}

        {/* Right Side: Instant Real-time Terminal View */}
        {(viewMode === "terminal" || viewMode === "split") && (
          <div className={viewMode === "split" ? "w-1/2 h-full" : "w-full h-full"}>
            <TerminalView ansiStream={ansiStream} />
          </div>
        )}
      </div>

      {/* CLI Bottom Status Bar */}
      <StatusBar
        branch={gitBranch}
        model={metadata.model}
        stats={stats}
        sessionId={metadata.sessionId}
        onOpenModal={setActiveModal}
      />

      {/* Modals */}
      <PermissionModal data={activePermission} onDecision={handleDecision} />

      {activeModal === "model" && (
        <ModelModal
          currentModel={metadata.model}
          onClose={() => setActiveModal(null)}
          onApply={handleApplyModel}
        />
      )}

      {activeModal === "config" && (
        <ConfigModal
          onClose={() => setActiveModal(null)}
          onApplyConfig={handleApplyConfig}
        />
      )}

      {activeModal === "mcp" && (
        <McpModal
          mcpServers={metadata.mcpServers}
          tools={metadata.tools}
          onClose={() => setActiveModal(null)}
        />
      )}

      {activeModal === "resume" && (
        <SessionsModal
          onClose={() => setActiveModal(null)}
          onResumeSession={handleResumeSession}
        />
      )}

      {activeModal === "tasks" && (
        <TasksModal
          tasks={tasks}
          onClose={() => setActiveModal(null)}
          onClearTasks={() => setTasks(new Map())}
        />
      )}

      {activeModal === "doctor" && (
        <DoctorModal
          onClose={() => setActiveModal(null)}
        />
      )}
    </div>
  );
}
