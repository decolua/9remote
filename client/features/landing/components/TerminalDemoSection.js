"use client";

import { useState, useEffect } from "react";

export default function TerminalDemoSection() {
  const [desktopText, setDesktopText] = useState("");
  const [desktopLines, setDesktopLines] = useState([]);
  const [mobileMessages, setMobileMessages] = useState([]);
  const [currentMessageText, setCurrentMessageText] = useState("");
  const [currentMessageIndex, setCurrentMessageIndex] = useState(0);
  const [isTypingUser, setIsTypingUser] = useState(true);

  const desktopCommands = [
    { type: "command", text: "npm install -g 9remote" },
    { type: "output", text: "→ Installing 9remote..." },
    { type: "success", text: "✓ Installation complete" },
    { type: "command", text: "9remote start" },
    { type: "output", text: "→ Starting server..." },
    { type: "output", text: "→ Creating tunnel..." },
    { type: "success", text: "✓ Server running on http://localhost:3000" },
    { type: "success", text: "✓ Tunnel ready: https://xxx.trycloudflare.com" },
    { type: "qr", text: "→ Connected! You can now code from anywhere" }
  ];

  const chatConversations = [
    [
      { role: "user", text: "Create a login form with validation" },
      { role: "ai", text: "I'll create a React login form with email and password validation..." }
    ],
    [
      { role: "user", text: "Add dark mode to my app" },
      { role: "ai", text: "I'll add a dark mode toggle using React context..." }
    ],
    [
      { role: "user", text: "Build an API with authentication" },
      { role: "ai", text: "I'll create an Express API with JWT authentication..." }
    ]
  ];

  // Desktop typing animation
  useEffect(() => {
    if (desktopLines.length >= desktopCommands.length) {
      // Reset after completion
      const resetTimer = setTimeout(() => {
        setDesktopLines([]);
        setDesktopText("");
      }, 3000);
      return () => clearTimeout(resetTimer);
    }

    const currentCommand = desktopCommands[desktopLines.length];
    if (!currentCommand) return;

    const fullText = currentCommand.text;
    
    if (desktopText.length < fullText.length) {
      const timer = setTimeout(() => {
        setDesktopText(fullText.slice(0, desktopText.length + 1));
      }, 50);
      return () => clearTimeout(timer);
    } else {
      const timer = setTimeout(() => {
        setDesktopLines([...desktopLines, { ...currentCommand, text: desktopText }]);
        setDesktopText("");
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [desktopText, desktopLines]);

  // Mobile chat animation - independent loop
  useEffect(() => {
    const conversationIndex = Math.floor(currentMessageIndex / 2) % chatConversations.length;
    const messageInConversation = currentMessageIndex % 2;
    const currentConversation = chatConversations[conversationIndex];
    const currentMessage = currentConversation[messageInConversation];

    if (!currentMessage) return;

    const fullText = currentMessage.text;
    
    if (currentMessageText.length < fullText.length) {
      const timer = setTimeout(() => {
        setCurrentMessageText(fullText.slice(0, currentMessageText.length + 1));
      }, 50);
      return () => clearTimeout(timer);
    } else {
      const timer = setTimeout(() => {
        setMobileMessages([...mobileMessages, { ...currentMessage, text: currentMessageText }]);
        setCurrentMessageText("");
        setCurrentMessageIndex(currentMessageIndex + 1);
        setIsTypingUser(!isTypingUser);
        
        // Reset after full conversation
        if (currentMessageIndex >= chatConversations[conversationIndex].length * 2 - 1) {
          setTimeout(() => {
            setMobileMessages([]);
            setCurrentMessageIndex(0);
            setIsTypingUser(true);
          }, 2000);
        }
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [currentMessageText, currentMessageIndex, mobileMessages, isTypingUser]);

  return (
    <section id="terminal-demo" className="relative py-20 px-4 sm:px-6 lg:px-8 bg-gray-50">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-4 text-gray-900">
            How It Works
          </h2>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            Connect your phone to your terminal in seconds
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-center">
          {/* Desktop Terminal */}
          <div className="relative">
            <div className="absolute -inset-4 bg-gradient-to-r from-[#E68A6E]/20 to-[#E68A6E]/10 rounded-2xl blur-2xl" />
            <div className="relative bg-white rounded-xl overflow-hidden shadow-2xl border border-gray-200">
              {/* Terminal header */}
              <div className="flex items-center gap-2 px-4 py-3 bg-gray-100 border-b border-gray-200">
                <div className="w-3 h-3 rounded-full bg-red-500" />
                <div className="w-3 h-3 rounded-full bg-yellow-500" />
                <div className="w-3 h-3 rounded-full bg-[#E68A6E]" />
                <span className="ml-2 text-xs text-gray-600 font-mono">terminal — Desktop</span>
              </div>

              {/* Terminal content */}
              <div className="p-6 font-mono text-sm min-h-[400px]">
                {desktopLines.map((line, index) => (
                  <div
                    key={index}
                    className={`mb-2 ${
                      line.type === "command"
                        ? "text-gray-900"
                        : line.type === "success"
                        ? "text-green-400"
                        : line.type === "qr"
                        ? "text-[#E68A6E]"
                        : "text-gray-600"
                    }`}
                  >
                    {line.type === "command" && (
                      <span className="text-[#E68A6E] mr-2">$</span>
                    )}
                    {line.text}
                  </div>
                ))}
                {desktopText && (
                  <div className="mb-2 text-gray-900">
                    {desktopCommands[desktopLines.length]?.type === "command" && (
                      <span className="text-[#E68A6E] mr-2">$</span>
                    )}
                    {desktopText}
                    <span className="inline-block w-2 h-4 bg-[#E68A6E] ml-1 animate-pulse" />
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Mobile Phone */}
          <div className="relative flex justify-center">
            <div>
              {/* Phone mockup */}
              <div className="relative w-[280px] h-[560px] bg-gray-900 rounded-[3rem] border-4 border-gray-800 shadow-2xl">
                {/* Notch */}
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-24 h-5 bg-gray-800 rounded-b-2xl z-10" />
                
                {/* Screen */}
                <div className="absolute inset-2 bg-white rounded-[2.5rem] overflow-hidden flex flex-col">
                  {/* Status bar */}
                  <div className="h-10 bg-white border-b border-gray-200 flex items-center justify-between px-3 pt-5">
                    <span className="text-xs font-semibold text-gray-900">Claude AI</span>
                    <div className="flex items-center gap-1">
                      <svg className="w-3 h-3 text-[#E68A6E]" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M17.778 8.222c-4.296-4.296-11.26-4.296-15.556 0A1 1 0 01.808 6.808c5.076-5.077 13.308-5.077 18.384 0a1 1 0 01-1.414 1.414zM14.95 11.05a7 7 0 00-9.9 0 1 1 0 01-1.414-1.414 9 9 0 0112.728 0 1 1 0 01-1.414 1.414zM12.12 13.88a3 3 0 00-4.242 0 1 1 0 01-1.415-1.415 5 5 0 017.072 0 1 1 0 01-1.415 1.415zM9 16a1 1 0 011-1h.01a1 1 0 110 2H10a1 1 0 01-1-1z" clipRule="evenodd" />
                      </svg>
                    </div>
                  </div>

                  {/* Chat messages */}
                  <div className="flex-1 overflow-auto p-3 space-y-3 bg-gray-50">
                    {mobileMessages.map((message, index) => (
                      <div
                        key={index}
                        className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                      >
                        <div
                          className={`max-w-[80%] rounded-2xl px-3 py-2 ${
                            message.role === "user"
                              ? "bg-[#E68A6E] text-white"
                              : "bg-white border border-gray-200 text-gray-900"
                          }`}
                        >
                          <p className="text-[10px] leading-relaxed">{message.text}</p>
                        </div>
                      </div>
                    ))}
                    
                    {/* Current typing message */}
                    {currentMessageText && (
                      <div className={`flex ${isTypingUser ? "justify-end" : "justify-start"}`}>
                        <div
                          className={`max-w-[80%] rounded-2xl px-3 py-2 ${
                            isTypingUser
                              ? "bg-[#E68A6E] text-white"
                              : "bg-white border border-gray-200 text-gray-900"
                          }`}
                        >
                          <p className="text-[10px] leading-relaxed">
                            {currentMessageText}
                            <span className="inline-block w-1 h-3 bg-current ml-0.5 animate-pulse" />
                          </p>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Input box */}
                  <div className="p-2 bg-white border-t border-gray-200">
                    <div className="flex items-center gap-2 bg-gray-100 rounded-full px-3 py-2">
                      <input
                        type="text"
                        placeholder="Ask AI to code..."
                        className="flex-1 bg-transparent text-[10px] text-gray-600 outline-none"
                        disabled
                      />
                      <div className="w-6 h-6 bg-[#E68A6E] rounded-full flex items-center justify-center">
                        <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Home indicator */}
                <div className="absolute bottom-1 left-1/2 -translate-x-1/2 w-24 h-1 bg-gray-700 rounded-full" />
              </div>

              {/* Connection line */}
              <div className="absolute top-1/2 -left-20 w-20 h-0.5 bg-gradient-to-r from-[#E68A6E] to-transparent animate-pulse" />
            </div>
          </div>
        </div>

      </div>

      {/* CSS for animations */}
      <style jsx>{`
        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </section>
  );
}
