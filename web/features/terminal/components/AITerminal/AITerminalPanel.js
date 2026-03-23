"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { X, Send, Copy, Check, Trash2, Sparkles } from "@/shared/components/ui/Icon";
import Spinner from "@/shared/components/ui/Spinner";
import { useAITerminalStorage } from "@/features/terminal/hooks/useAITerminalStorage";
import { AI_TERMINAL_CONFIG } from "@/features/terminal/constants/aiTerminal";
import { WORKER_API } from "@/shared/constants/API";
import { vibrate } from "@/shared/utils/vibration";
import { useDeviceInfo } from "@/shared/hooks/useDeviceInfo";

/**
 * AITerminal Panel - Chat interface for AI terminal commands
 */
export default function AITerminalPanel({ isOpen, onClose, platform }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  const { loadHistory, addMessage, clearHistory } = useAITerminalStorage();
  const { isIosPwa } = useDeviceInfo();

  // Load history on mount
  useEffect(() => {
    if (isOpen) {
      setMessages(loadHistory());
    }
  }, [isOpen, loadHistory]);

  // Auto scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Handle send message
  const handleSend = useCallback(async () => {
    if (!input.trim() || loading) return;

    vibrate();
    const userMessage = { role: "user", content: input.trim() };
    
    // Add user message
    const updatedWithUser = addMessage(userMessage);
    setMessages(updatedWithUser);
    setInput("");
    setLoading(true);

    try {
      // Map platform to OS name
      const getOSName = (p) => {
        if (p === "win32") return "Windows";
        if (p === "darwin") return "macOS";
        if (p === "linux") return "Linux";
        return p || "Unix";
      };

      const response = await fetch(`${WORKER_API}/api/ai-terminal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage.content, os: getOSName(platform) })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to get response");
      }

      // Add AI response
      const aiMessage = { role: "assistant", content: data.command };
      const updatedWithAi = addMessage(aiMessage);
      setMessages(updatedWithAi);
    } catch (error) {
      console.error("AITerminal error:", error);
      const errorMessage = { role: "assistant", content: `Error: ${error.message}`, isError: true };
      const updatedWithError = addMessage(errorMessage);
      setMessages(updatedWithError);
    } finally {
      setLoading(false);
    }
  }, [input, loading, addMessage]);

  // Handle copy
  const handleCopy = useCallback((id, content) => {
    vibrate();
    navigator.clipboard.writeText(content);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  // Handle clear history
  const handleClear = useCallback(() => {
    vibrate();
    clearHistory();
    setMessages([]);
  }, [clearHistory]);

  // Handle key press
  const handleKeyPress = useCallback((e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  // Close on Escape
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px] fade-in"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className="absolute top-0 right-0 bottom-0 w-[85vw] sm:w-96 max-w-md bg-dark-600 border-l border-dark-400 shadow-2xl flex flex-col slide-in-right"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={`flex items-center justify-between px-4 py-3 border-b border-dark-400 flex-shrink-0 ${isIosPwa ? "safe-area-top" : ""}`}>
          <div className="flex items-center gap-2">
            <Sparkles size={20} className="text-brand-500" />
            <h2 className="text-lg font-semibold text-white">AI Terminal</h2>
          </div>
          <div className="flex items-center gap-1">
            {messages.length > 0 && (
              <button
                onClick={handleClear}
                className="p-2 text-dark-100 hover:text-red-400 hover:bg-dark-500 rounded-brand transition-colors"
                title="Clear history"
              >
                <Trash2 size={18} />
              </button>
            )}
            <button
              onClick={onClose}
              className="p-2 text-dark-100 hover:text-white hover:bg-dark-500 rounded-brand transition-colors"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3 modal-scrollable">
          {messages.length === 0 && (
            <div className="text-center text-dark-100 py-8">
              <Sparkles size={32} className="mx-auto mb-3 text-dark-200" />
              <p className="text-sm">Describe what you want to do</p>
              <p className="text-xs text-dark-200 mt-1">AI will generate the terminal command</p>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 ${
                  msg.role === "user"
                    ? "bg-brand-600 text-white"
                    : msg.isError
                    ? "bg-red-900/50 text-red-300 border border-red-700"
                    : "bg-dark-500 text-white"
                }`}
              >
                <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
                
                {/* Copy button for AI responses */}
                {msg.role === "assistant" && !msg.isError && (
                  <button
                    onClick={() => handleCopy(msg.id, msg.content)}
                    className="mt-2 flex items-center gap-1 text-xs text-dark-100 hover:text-brand-400 transition-colors"
                  >
                    {copiedId === msg.id ? (
                      <>
                        <Check size={14} className="text-green-400" />
                        <span className="text-green-400">Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy size={14} />
                        <span>Copy command</span>
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="bg-dark-500 rounded-lg px-4 py-3">
                <Spinner size={20} />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className={`p-3 border-t border-dark-400 flex-shrink-0 ${isIosPwa ? "safe-area-bottom" : ""}`}>
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder={AI_TERMINAL_CONFIG.placeholder}
              disabled={loading}
              className="flex-1 bg-dark-500 border border-dark-400 rounded-brand px-3 py-2 text-white text-sm placeholder-dark-100 focus:outline-none focus:border-brand-500 disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || loading}
              className="p-2 bg-brand-600 hover:bg-brand-500 disabled:bg-dark-400 disabled:cursor-not-allowed text-white rounded-brand transition-colors"
            >
              <Send size={20} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
