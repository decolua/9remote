"use client";

import { useState, useEffect, useRef } from "react";
import { THEME, CLAUDE_CODE_SEQUENCE, PHONE_CHAT_SEQUENCE, TIMING } from "../constants/landingConfig";

// Typing effect hook with loop reset
function useTypingSequence(sequence) {
  const [lines, setLines] = useState([]);
  const [currentText, setCurrentText] = useState("");
  const indexRef = useRef(0);

  useEffect(() => {
    if (indexRef.current >= sequence.length) {
      const reset = setTimeout(() => {
        setLines([]);
        setCurrentText("");
        indexRef.current = 0;
      }, TIMING.loopReset);
      return () => clearTimeout(reset);
    }

    const current = sequence[indexRef.current];
    if (!current) return;

    if (currentText.length < current.text.length) {
      const t = setTimeout(() => setCurrentText(current.text.slice(0, currentText.length + 1)), TIMING.typeSpeed);
      return () => clearTimeout(t);
    }

    const t = setTimeout(() => {
      setLines((prev) => [...prev, { ...current }]);
      setCurrentText("");
      indexRef.current += 1;
    }, TIMING.lineDelay);
    return () => clearTimeout(t);
  }, [currentText, lines, sequence]);

  const activeLine = indexRef.current < sequence.length ? sequence[indexRef.current] : null;
  return { lines, currentText, activeLine };
}

// Color mapping for Claude Code terminal lines
function lineColor(type) {
  switch (type) {
    case "user": return THEME.accent;
    case "assistant": return "#E5E5E5";
    case "tool": return "#60A5FA";
    case "diff-add": return THEME.success;
    case "success": return THEME.success;
    default: return THEME.textDim;
  }
}

// MacBook window frame with Claude Code terminal inside
export function MacbookClaudeCode() {
  const { lines, currentText, activeLine } = useTypingSequence(CLAUDE_CODE_SEQUENCE);

  return (
    <div className="relative w-full max-w-full sm:max-w-[620px]">
      <div
        className="absolute -inset-8 opacity-60 blur-3xl pointer-events-none"
        style={{ background: `radial-gradient(ellipse at center, ${THEME.accentGlow} 0%, transparent 70%)` }}
      />
      <div
        className="relative rounded-xl overflow-hidden border shadow-2xl"
        style={{ background: THEME.bgElevated, borderColor: THEME.border }}
      >
        <div
          className="flex items-center gap-2 px-3 sm:px-4 py-2.5 sm:py-3 border-b"
          style={{ background: "#1F1F1F", borderColor: THEME.border }}
        >
          <div className="flex gap-1.5 sm:gap-2 flex-shrink-0">
            <div className="w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full" style={{ background: "#FF5F57" }} />
            <div className="w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full" style={{ background: "#FEBC2E" }} />
            <div className="w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full" style={{ background: "#28C840" }} />
          </div>
          <span className="ml-2 sm:ml-3 text-[10px] sm:text-xs font-mono truncate min-w-0" style={{ color: THEME.textDim }}>
            claude-code<span className="hidden sm:inline"> — 9remote ~/project</span>
          </span>
          <span
            className="ml-auto text-[9px] sm:text-[10px] px-1.5 sm:px-2 py-0.5 rounded font-mono flex-shrink-0"
            style={{ background: THEME.accentSoft, color: THEME.accent }}
          >
            ● live
          </span>
        </div>

        <div
          className="p-3 sm:p-5 font-mono text-[11px] sm:text-[13px] leading-relaxed min-h-[320px] sm:min-h-[380px] overflow-hidden"
          style={{ background: THEME.bgElevated }}
        >
          {lines.map((line, i) => (
            <div key={i} style={{ color: lineColor(line.type) }} className="mb-1 sm:mb-1.5 whitespace-pre-wrap break-all">
              {line.text}
            </div>
          ))}
          {activeLine && (
            <div style={{ color: lineColor(activeLine.type) }} className="mb-1 sm:mb-1.5 whitespace-pre-wrap break-all">
              {currentText}
              <span
                className="inline-block w-[6px] h-[12px] sm:w-[7px] sm:h-[14px] ml-0.5 align-middle animate-cursor-blink"
                style={{ background: THEME.accent }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// iPhone frame with live chat (user prompting AI on the go)
export function IPhoneChat() {
  const { lines, currentText, activeLine } = useTypingSequence(PHONE_CHAT_SEQUENCE);

  return (
    <div className="relative">
      <div
        className="absolute -inset-6 opacity-50 blur-3xl pointer-events-none"
        style={{ background: `radial-gradient(ellipse at center, ${THEME.accentGlow} 0%, transparent 70%)` }}
      />
      <div
        className="relative w-[260px] h-[540px] rounded-[3rem] p-3 shadow-2xl animate-float-phone"
        style={{ background: "#0A0A0A", border: `1px solid ${THEME.borderStrong}` }}
      >
        <div
          className="w-full h-full rounded-[2.3rem] overflow-hidden flex flex-col relative"
          style={{ background: THEME.bg }}
        >
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-28 h-6 rounded-b-3xl z-10" style={{ background: "#0A0A0A" }} />

          <div
            className="h-11 flex items-center justify-between px-5 pt-4 text-[10px] font-semibold"
            style={{ color: THEME.text }}
          >
            <span>9:41</span>
            <span style={{ color: THEME.accent }}>● 9remote</span>
          </div>

          <div className="h-9 flex items-center gap-2 px-4 border-b" style={{ borderColor: THEME.border }}>
            <div className="w-6 h-6 rounded-md flex items-center justify-center text-[10px] font-bold"
              style={{ background: THEME.accent, color: "#FFF" }}>C</div>
            <div className="flex-1">
              <div className="text-[11px] font-semibold" style={{ color: THEME.text }}>Claude Code</div>
              <div className="text-[8px]" style={{ color: THEME.success }}>● connected via tunnel</div>
            </div>
          </div>

          <div className="flex-1 overflow-hidden p-3 space-y-2">
            {lines.map((m, i) => (
              <ChatBubble key={i} role={m.role} text={m.text} />
            ))}
            {activeLine && <ChatBubble role={activeLine.role} text={currentText} typing />}
          </div>

          <div className="p-2.5 border-t" style={{ borderColor: THEME.border }}>
            <div className="flex items-center gap-2 rounded-full px-3 py-2" style={{ background: THEME.bgPanel }}>
              <span className="flex-1 text-[10px]" style={{ color: THEME.textMuted }}>Message Claude…</span>
              <div className="w-5 h-5 rounded-full flex items-center justify-center" style={{ background: THEME.accent }}>
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="#FFF">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </div>
            </div>
          </div>
        </div>

        <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 w-28 h-1 rounded-full" style={{ background: "#2A2A2A" }} />
      </div>
    </div>
  );
}

function ChatBubble({ role, text, typing }) {
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className="max-w-[80%] rounded-2xl px-2.5 py-1.5"
        style={{
          background: isUser ? THEME.accent : THEME.bgPanel,
          color: isUser ? "#FFF" : THEME.text,
          border: isUser ? "none" : `1px solid ${THEME.border}`
        }}
      >
        <p className="text-[10px] leading-snug">
          {text}
          {typing && <span className="inline-block w-[4px] h-[9px] ml-0.5 align-middle animate-cursor-blink" style={{ background: "currentColor" }} />}
        </p>
      </div>
    </div>
  );
}

// Animated beam connecting 2 devices (desktop → phone)
export function ConnectionBeam() {
  return (
    <div className="hidden lg:block absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[120px] h-[2px] pointer-events-none z-20">
      <div className="absolute inset-0 overflow-hidden rounded-full" style={{ background: "rgba(255,87,10,0.15)" }}>
        <div className="absolute inset-y-0 left-0 w-[30%] animate-beam-flow" style={{ background: `linear-gradient(90deg, transparent, ${THEME.accent}, transparent)` }} />
      </div>
    </div>
  );
}
