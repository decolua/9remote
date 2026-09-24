"use client";

import { THEME } from "../constants/landingConfig";

const SUPERPOWERS = [
  {
    name: "Every Harness · One UI",
    path: "M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
  },
  {
    name: "Remote IDE",
    path: "M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
  },
  {
    name: "Remote Vibe Coding",
    path: "M13 10V3L4 14h7v7l9-11h-7z"
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
    name: "PC · Web · iPad · Mobile",
    path: "M12 18h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"
  }
];

const PHONES = [
  { src: "/screenshots/mobile-1.webp", alt: "Claude Code running in 9Remote on a phone" },
  { src: "/screenshots/mobile-2.webp", alt: "File explorer in 9Remote on a phone" },
  { src: "/screenshots/mobile-3.webp", alt: "System dashboard in 9Remote on a phone" }
];

export default function HeroSection() {
  return (
    <section className="relative min-h-screen flex items-center px-4 sm:px-6 lg:px-8 pt-24 pb-16 overflow-hidden">
      <div className="max-w-7xl mx-auto relative z-10 w-full min-w-0">
        <div className="grid lg:grid-cols-2 gap-12 items-center min-w-0">
          {/* Left: Content */}
          <div className="text-center lg:text-left">
            <h1 className="mb-5 animate-fade-in-delay-1" style={{ fontWeight: 900, lineHeight: 1.1 }}>
              <span className="block text-2xl sm:text-3xl lg:text-4xl xl:text-5xl mb-2" style={{ color: THEME.text }}>
                Remote Everything,
              </span>
              <span
                className="block text-2xl sm:text-3xl lg:text-4xl xl:text-5xl mb-3"
                style={{
                  background: `linear-gradient(to right, ${THEME.text}, ${THEME.textDim})`,
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent"
                }}
              >
                Vibecode Everywhere
              </span>
            </h1>

            {/* Superpower Pills */}
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

            <p className="font-mono text-xs sm:text-sm mb-3 max-w-xl mx-auto lg:mx-0" style={{ color: THEME.accent }}>
              Codex CLI looks like 1995? Claude Code's TUI hurts? Forget them. Same agents, one UI you'll actually love.
            </p>

            <p
              className="hero-gloss text-sm sm:text-base mb-8 max-w-xl mx-auto lg:mx-0"
              data-text="Leave your laptop behind. Your entire dev workstation goes wherever you go — remote IDE, 60fps desktop, visual file explorer, live mobile emulator, and every AI harness in one UI: Claude Code, Codex, Cursor & 30+ agents on PC, Web, iPad, or phone."
            >
              Leave your laptop behind. Your entire dev workstation goes wherever you go — remote IDE, 60fps desktop, visual file explorer, live mobile emulator, and every AI harness in one UI: Claude Code, Codex, Cursor & 30+ agents on PC, Web, iPad, or phone.
            </p>

            {/* Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6 max-w-lg mx-auto lg:mx-0 mt-7 animate-fade-in-delay-6">
              {[
                { val: "Direct P2P", label: "WebRTC DataChannel" },
                { val: "<20ms", label: "Ultra-Low Latency" },
                { val: "30+ AI Agents", label: "Vibe Coding Ready" },
                { val: "Persistent", label: "PTY Daemon Sessions" }
              ].map((s) => (
                <div key={s.label} className="text-center lg:text-left">
                  <div className="text-base sm:text-lg font-bold mb-0.5" style={{ color: THEME.text }}>{s.val}</div>
                  <div className="text-xs font-mono" style={{ color: THEME.textDim }}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Right: real screens — desktop window + phone overlapping the corner */}
          <div className="relative w-full flex justify-center items-center lg:justify-end animate-fade-in-delay-2 min-w-0 mt-4 lg:mt-0">
            <div className="relative w-full max-w-full sm:max-w-[620px] -translate-y-2 sm:-translate-y-5">
              <div
                className="absolute -inset-8 opacity-50 blur-3xl pointer-events-none"
                style={{ background: "radial-gradient(ellipse at center, rgba(255,255,255,0.10) 0%, transparent 70%)" }}
              />
              <div
                className="relative rounded-xl overflow-hidden border shadow-2xl"
                style={{ background: THEME.bgElevated, borderColor: THEME.border }}
              >
                <div
                  className="flex items-center gap-2 px-3 sm:px-4 py-2.5 sm:py-3 border-b"
                  style={{ background: THEME.bgPanel, borderColor: THEME.border }}
                >
                  <div className="flex gap-1.5 sm:gap-2 flex-shrink-0">
                    <div className="w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full" style={{ background: "#FF5F57" }} />
                    <div className="w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full" style={{ background: "#FEBC2E" }} />
                    <div className="w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full" style={{ background: "#28C840" }} />
                  </div>
                  <span className="ml-2 sm:ml-3 text-[10px] sm:text-xs font-mono truncate min-w-0" style={{ color: THEME.textDim }}>
                    9remote<span className="hidden sm:inline"> — desktop</span>
                  </span>
                </div>
                <img
                  src="/screenshots/desktop-ide.webp"
                  alt="9Remote desktop workspace: terminal, editor and AI agent panes side by side"
                  className="w-full block"
                />
              </div>
              {/* Phones — on desktop tucked into the card's corner so they only clip the
                  screen; on a phone screen they drop below it as a row instead, sized so
                  three of them fit the viewport (in flow, so no clipping and no gap). */}
              <div className="mt-5 flex w-max mx-auto items-end gap-2 sm:absolute sm:mt-0 sm:mx-0 sm:-bottom-[134px] sm:-right-8 sm:gap-3 sm:origin-bottom-right sm:scale-[0.66]">
                {PHONES.map((phone, i) => (
                  <div
                    key={phone.src}
                    className="relative w-[100px] sm:w-[180px] rounded-[1.1rem] p-0.5 shadow-2xl animate-float-phone"
                    style={{
                      background: THEME.bg,
                      border: `1px solid ${THEME.borderStrong}`,
                      animationDelay: `${i * 0.9}s`
                    }}
                  >
                    <img
                      src={phone.src}
                      alt={phone.alt}
                      loading="lazy"
                      className="w-full block rounded-[0.95rem]"
                    />
                  </div>
                ))}
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
        .animate-fade-in-delay-1 { opacity: 0; animation: fadeIn 0.8s ease-out 0.1s forwards; }
        /* Fading reflection under the paragraph — gloss reads even where the card below overlaps */
        .hero-gloss { position: relative; color: ${THEME.textDim}; }
        .hero-gloss::after {
          content: attr(data-text);
          position: absolute;
          top: 100%;
          left: 0;
          right: 0;
          white-space: pre-wrap;
          transform: scaleY(-1);
          transform-origin: top;
          background: linear-gradient(to bottom, ${THEME.textDim}, transparent 40%);
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
          opacity: 0.35;
          pointer-events: none;
          user-select: none;
        }
        .animate-fade-in-delay-4 { opacity: 0; animation: fadeIn 0.8s ease-out 0.4s forwards; }
        .animate-fade-in-delay-5 { opacity: 0; animation: fadeIn 0.8s ease-out 0.5s forwards; }
        .animate-fade-in-delay-6 { opacity: 0; animation: fadeIn 0.8s ease-out 0.6s forwards; }
      `}</style>
    </section>
  );
}
