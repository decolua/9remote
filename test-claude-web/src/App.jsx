// test-claude-web/src/App.jsx
import React, { useState, useEffect, useRef } from "react";
import { Header } from "./components/Header.jsx";
import { TaskBar } from "./components/TaskBar.jsx";
import { ChatTimeline } from "./components/ChatTimeline.jsx";
import { TerminalView } from "./components/TerminalView.jsx";
import { PermissionModal } from "./components/PermissionModal.jsx";

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
  const [prompt, setPrompt] = useState("");
  const isTurnRunning = status === "busy";

  // Global Keybinding: Ctrl + ~ to cycle view mode
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "`" || e.key === "~")) {
        e.preventDefault();
        setViewMode((curr) => (curr === "ui" ? "split" : curr === "split" ? "terminal" : "ui"));
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

    es.addEventListener("done", () => {
      setStatus("idle");
    });

    es.addEventListener("init", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.permissionMode) setPermissionMode(data.permissionMode);
      } catch {}
    });

    return () => es.close();
  }, []);

  const sendChatMessage = async (text) => {
    if (!text || isTurnRunning) return;
    setStatus("busy");
    setMessages((prev) => [...prev, { role: "user", text }]);

    try {
      await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
    } catch (err) {
      alert("Lỗi gửi chat: " + err.message);
      setStatus("idle");
    }
  };

  const handleSend = () => {
    const text = prompt.trim();
    if (!text || isTurnRunning) return;
    setPrompt("");
    sendChatMessage(text);
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

  return (
    <div className="h-screen w-screen flex flex-col bg-[#07090e] text-slate-100 overflow-hidden font-sans">
      <Header
        status={status}
        viewMode={viewMode}
        onViewChange={setViewMode}
        permissionMode={permissionMode}
        onModeChange={handleModeChange}
        onReset={handleReset}
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

            {/* Input Bar */}
            <div className="p-4 bg-slate-900/90 border-t border-white/10 flex flex-col gap-2">
              <div className="flex items-center gap-2 bg-black/40 border border-white/10 rounded-xl p-2 focus-within:border-blue-500 transition-all">
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder="Gửi yêu cầu... (Gõ lệnh, hỏi bài, duyệt file)"
                  rows={1}
                  className="flex-1 bg-transparent border-none text-sm text-white outline-none resize-none px-2"
                />
                {isTurnRunning ? (
                  <button
                    onClick={handleStop}
                    className="px-4 py-1.5 rounded-lg text-xs font-semibold text-rose-300 bg-rose-500/20 border border-rose-500/40 hover:bg-rose-500/30"
                  >
                    Dừng
                  </button>
                ) : (
                  <button
                    disabled={!prompt.trim()}
                    onClick={handleSend}
                    className="px-5 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-40 shadow-sm"
                  >
                    Gửi
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Right Side: Instant Real-time Terminal View */}
        {(viewMode === "terminal" || viewMode === "split") && (
          <div className={viewMode === "split" ? "w-1/2 h-full" : "w-full h-full"}>
            <TerminalView ansiStream={ansiStream} />
          </div>
        )}
      </div>

      <PermissionModal data={activePermission} onDecision={handleDecision} />
    </div>
  );
}
