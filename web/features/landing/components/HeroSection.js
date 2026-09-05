"use client";

import { useState } from "react";
import Link from "next/link";
import { MacbookClaudeCode, IPhoneChat } from "./DeviceShowcase";
import { THEME } from "../constants/landingConfig";

const SUPERPOWERS = [
  {
    name: "Remote IDE",
    path: "M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
  },
  {
    name: "Remote Desktop",
    path: "M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
  },
  {
    name: "Remote Files",
    path: "M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
  },
  {
    name: "Remote Emulator",
    path: "M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
  },
  {
    name: "Remote Localhost",
    path: "M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
  },
  {
    name: "Mobile Full Feature",
    path: "M12 18h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"
  }
];

export default function HeroSection() {
  const [copied, setCopied] = useState(false);

  const copyCommand = () => {
    navigator.clipboard?.writeText("npx 9remote").catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="relative min-h-screen flex items-center px-4 sm:px-6 lg:px-8 pt-24 pb-16 overflow-hidden">
      <div className="max-w-7xl mx-auto relative z-10 w-full min-w-0">
        <div className="grid lg:grid-cols-2 gap-12 items-center min-w-0">
          {/* Left: Content */}
          <div className="text-center lg:text-left">
            <div
              className="inline-flex items-center gap-2 px-3.5 py-1.5 mb-6 rounded-full border animate-fade-in"
              style={{ borderColor: THEME.border, background: THEME.bgPanel }}
            >
              <svg className="w-3.5 h-3.5" style={{ color: THEME.accent }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              <span className="text-xs font-medium font-mono" style={{ color: THEME.textDim }}>
                Ultra-Low Latency WebRTC · Built for Mobile
              </span>
            </div>

            <h1 className="mb-5 animate-fade-in-delay-1" style={{ fontWeight: 900, lineHeight: 1.1 }}>
              <span className="block text-3xl sm:text-4xl lg:text-5xl xl:text-6xl mb-2" style={{ color: THEME.text }}>
                Code from anywhere
              </span>
              <span
                className="block text-3xl sm:text-4xl lg:text-5xl xl:text-6xl mb-3"
                style={{
                  background: `linear-gradient(to right, ${THEME.text}, ${THEME.textDim})`,
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent"
                }}
              >
                on Earth.
              </span>
            </h1>

            {/* 5 Superpower Pills */}
            <div className="flex flex-wrap gap-2 mb-6 justify-center lg:justify-start animate-fade-in-delay-2">
              {SUPERPOWERS.map((badge) => (
                <span
                  key={badge.name}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-medium border transition-colors hover:border-text-subtle"
                  style={{ borderColor: THEME.border, background: THEME.bgPanel, color: THEME.text }}
                >
                  <svg className="w-3.5 h-3.5" style={{ color: THEME.accent }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d={badge.path} />
                  </svg>
                  <span>{badge.name}</span>
                </span>
              ))}
            </div>

            <p className="text-base sm:text-lg mb-8 max-w-xl mx-auto lg:mx-0 animate-fade-in-delay-3" style={{ color: THEME.textDim }}>
              Your dev machine stays home. Your entire workflow goes everywhere. Turn your PC or Mac into a personal remote dev suite — connect directly via WebRTC P2P for buttery-smooth mobile coding.
            </p>

            <div className="flex flex-row gap-2.5 sm:gap-3 justify-center lg:justify-start items-center mb-8 animate-fade-in-delay-4 flex-wrap">
              <Link
                href="/login"
                className="btn-cta group px-5 sm:px-6 py-3 rounded-lg font-bold text-sm sm:text-base transition-transform duration-300 hover:scale-[1.03]"
                style={{ background: THEME.accent, color: "#FFF" }}
              >
                <span className="flex items-center justify-center gap-2">
                  <span>Get Remote</span>
                  <svg className="w-4 h-4 group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                  </svg>
                </span>
              </Link>

              <Link
                href="https://docs.9remote.cc/"
                target="_blank"
                rel="noopener noreferrer"
                className="group px-5 sm:px-6 py-3 rounded-lg font-bold text-sm sm:text-base transition-all duration-300 hover:scale-[1.03] border"
                style={{ background: THEME.bgPanel, borderColor: THEME.border, color: THEME.text }}
              >
                <span className="flex items-center justify-center gap-2">
                  <span>Docs</span>
                  <svg className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </span>
              </Link>
            </div>

            {/* Quick 1-line command */}
            <div className="max-w-xl mx-auto lg:mx-0 animate-fade-in-delay-5">
              <div
                className="p-3.5 sm:p-4 rounded-xl border shadow-sm"
                style={{ background: THEME.bgElevated, borderColor: THEME.border }}
              >
                <div className="flex items-center justify-between gap-2 mb-2.5">
                  <div className="flex items-center gap-2">
                    <div className="flex gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#FF5F57" }} />
                      <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#FEBC2E" }} />
                      <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#28C840" }} />
                    </div>
                    <span className="text-xs ml-2 font-mono" style={{ color: THEME.textDim }}>run on host machine</span>
                  </div>
                  <button
                    onClick={copyCommand}
                    className="px-2.5 py-1 text-xs font-mono rounded border transition-colors flex items-center gap-1.5"
                    style={{
                      background: THEME.bgPanel,
                      borderColor: THEME.border,
                      color: copied ? THEME.success : THEME.text
                    }}
                  >
                    {copied ? "✓ Copied" : "Copy"}
                  </button>
                </div>
                <div className="font-mono text-sm flex items-center gap-2">
                  <span style={{ color: THEME.textDim }}>$</span>
                  <code style={{ color: THEME.text }} className="font-bold">npx 9remote</code>
                </div>
                <div className="text-xs mt-2.5 flex items-center gap-2" style={{ color: THEME.textDim }}>
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20" style={{ color: THEME.success }}>
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  <span>Zero config · No port forwarding · Ready in 30s</span>
                </div>
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-6 max-w-md mx-auto lg:mx-0 mt-7 animate-fade-in-delay-6">
              {[
                { val: "Direct P2P", label: "WebRTC DataChannel" },
                { val: "<20ms", label: "Ultra-Low Latency" },
                { val: "Persistent", label: "PTY Daemon Sessions" }
              ].map((s) => (
                <div key={s.label} className="text-center lg:text-left">
                  <div className="text-base sm:text-lg font-bold mb-0.5" style={{ color: THEME.text }}>{s.val}</div>
                  <div className="text-xs font-mono" style={{ color: THEME.textDim }}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Right: Device showcase — MacBook (Claude Code) + floating iPhone */}
          <div className="relative w-full flex justify-center items-center lg:justify-end animate-fade-in-delay-2 min-w-0 mt-4 lg:mt-0">
            <div className="relative w-full max-w-full sm:max-w-[620px]">
              <MacbookClaudeCode />
              {/* iPhone — scaled smaller on mobile so it stays visible */}
              <div className="absolute -bottom-10 -right-2 scale-[0.55] origin-bottom-right sm:scale-100 sm:-bottom-16 sm:-right-10">
                <IPhoneChat />
              </div>
            </div>
          </div>
        </div>
      </div>

      <style jsx>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-in { animation: fadeIn 0.8s ease-out forwards; }
        .animate-fade-in-delay-1 { opacity: 0; animation: fadeIn 0.8s ease-out 0.1s forwards; }
        .animate-fade-in-delay-2 { opacity: 0; animation: fadeIn 0.9s ease-out 0.25s forwards; }
        .animate-fade-in-delay-3 { opacity: 0; animation: fadeIn 0.8s ease-out 0.3s forwards; }
        .animate-fade-in-delay-4 { opacity: 0; animation: fadeIn 0.8s ease-out 0.4s forwards; }
        .animate-fade-in-delay-5 { opacity: 0; animation: fadeIn 0.8s ease-out 0.5s forwards; }
        .animate-fade-in-delay-6 { opacity: 0; animation: fadeIn 0.8s ease-out 0.6s forwards; }
      `}</style>
    </section>
  );
}
