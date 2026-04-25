"use client";

import Link from "next/link";
import { MacbookClaudeCode, IPhoneChat } from "./DeviceShowcase";
import { THEME } from "../constants/landingConfig";

export default function HeroSection() {
  return (
    <section className="relative min-h-screen flex items-center px-4 sm:px-6 lg:px-8 pt-24 pb-16 overflow-hidden">
      <div className="max-w-7xl mx-auto relative z-10 w-full min-w-0">
        <div className="grid lg:grid-cols-2 gap-12 items-center min-w-0">
          {/* Left: Content */}
          <div className="text-center lg:text-left">
            <div
              className="inline-flex items-center gap-2 px-3 py-1.5 mb-6 rounded-full border animate-fade-in"
              style={{ borderColor: THEME.borderAccent, background: THEME.accentSoft }}
            >
              <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: THEME.accent }} />
              <span className="text-xs font-medium" style={{ color: THEME.accent }}>
                v{process.env.NEXT_PUBLIC_SERVER_VERSION} · Now Available
              </span>
            </div>

            <h1 className="mb-5 animate-fade-in-delay-1" style={{ fontWeight: 900, lineHeight: 1.1 }}>
              <span className="block text-2xl sm:text-3xl lg:text-4xl xl:text-5xl mb-2" style={{ color: THEME.text }}>
                Code from bed.
              </span>
              <span className="block text-2xl sm:text-3xl lg:text-4xl xl:text-5xl mb-2" style={{ color: THEME.text }}>
                Fix bugs at the cafe.
              </span>
              <span
                className="block text-2xl sm:text-3xl lg:text-4xl xl:text-5xl"
                style={{
                  background: `linear-gradient(90deg, ${THEME.accent}, #FF9566)`,
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent"
                }}
              >
                Deploy from anywhere.
              </span>
            </h1>

            <p className="text-base sm:text-lg mb-8 max-w-xl mx-auto lg:mx-0 animate-fade-in-delay-3" style={{ color: THEME.textDim }}>
              Your terminal. Your phone. Zero config. Claude Code in your pocket.
            </p>

            <div className="flex flex-row gap-2.5 sm:gap-3 justify-center lg:justify-start items-center mb-10 animate-fade-in-delay-4 flex-wrap">
              <Link
                href="/login"
                className="btn-cta group px-4 sm:px-6 py-2.5 sm:py-3 rounded-lg font-bold text-sm sm:text-base transition-transform duration-300 hover:scale-[1.03]"
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
                className="group px-4 sm:px-6 py-2.5 sm:py-3 rounded-lg font-bold text-sm sm:text-base transition-all duration-300 hover:scale-[1.03] border"
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

            {/* Install command */}
            <div className="max-w-xl mx-auto lg:mx-0 animate-fade-in-delay-5">
              <div
                className="p-4 rounded-xl border"
                style={{ background: THEME.bgElevated, borderColor: THEME.border }}
              >
                <div className="flex items-center gap-2 mb-3">
                  <div className="flex gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#FF5F57" }} />
                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#FEBC2E" }} />
                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#28C840" }} />
                  </div>
                  <span className="text-xs ml-2 font-mono" style={{ color: THEME.textDim }}>terminal</span>
                </div>
                <div className="space-y-1.5 font-mono text-sm">
                  <div className="flex items-center gap-2">
                    <span style={{ color: THEME.accent }}>$</span>
                    <code style={{ color: THEME.text }}>npm install -g 9remote</code>
                  </div>
                  <div className="flex items-center gap-2">
                    <span style={{ color: THEME.accent }}>$</span>
                    <code style={{ color: THEME.text }}>9remote</code>
                  </div>
                  <div className="text-xs mt-2 flex items-center gap-2" style={{ color: THEME.textDim }}>
                    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20" style={{ color: THEME.success }}>
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    <span>Ready in 30 seconds</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-6 max-w-md mx-auto lg:mx-0 mt-8 animate-fade-in-delay-6">
              {[
                { val: "100%", label: "Secure" },
                { val: "<50ms", label: "Latency" },
                { val: "24/7", label: "Available" }
              ].map((s) => (
                <div key={s.label} className="text-center lg:text-left">
                  <div className="text-xl sm:text-2xl font-bold mb-1" style={{ color: THEME.accent }}>{s.val}</div>
                  <div className="text-xs" style={{ color: THEME.textDim }}>{s.label}</div>
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
