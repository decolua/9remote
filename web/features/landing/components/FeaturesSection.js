"use client";

import { THEME } from "../constants/landingConfig";

const PAIN_POINTS = [
  {
    title: "Remote Localhost Preview",
    pain: "Run `npm run dev` but can't view localhost:3000 on your phone?",
    solution: "Integrated Service Worker bridge previews your local dev servers directly in your mobile browser. Zero port forwarding, no ngrok tunnels.",
    path: "M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
  },
  {
    title: "Touch File Explorer & Editor",
    pain: "Fighting vim or nano on a virtual keyboard to tweak code?",
    solution: "Smooth mobile-friendly file tree, syntax-highlighted editor, and visual Git diff viewer designed for touch screens and quick edits.",
    path: "M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
  },
  {
    title: "Remote Desktop & Emulator",
    pain: "Building mobile apps without seeing or tapping the running simulator?",
    solution: "Low-latency WebRTC screen stream. View and interact with Android Emulator or iOS Simulator directly using multi-touch gestures.",
    path: "M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
  },
  {
    title: "Persistent Terminal Daemon",
    pain: "Switching apps to reply to chat disconnects SSH and kills your task?",
    solution: "Background PTY daemon keeps your sessions alive on your host machine. Network drops or app switches never interrupt running builds or AI agents.",
    path: "M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
  }
];

export default function FeaturesSection() {
  return (
    <section id="features" className="relative py-24 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-4" style={{ color: THEME.text }}>
            Coding on Phone, <span style={{ color: THEME.text }}>Solved</span>
          </h2>
          <p className="text-lg max-w-2xl mx-auto" style={{ color: THEME.textDim }}>
            Mobile coding breaks when you cannot preview web apps, edit files, or test UI. 9Remote eliminates the bottlenecks.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {PAIN_POINTS.map((item, index) => (
            <div
              key={item.title}
              className="group relative p-6 sm:p-8 rounded-xl border transition-all duration-300 hover:-translate-y-1"
              style={{
                background: THEME.bgElevated,
                borderColor: THEME.border,
                animation: `fadeInUp 0.4s ease-out ${index * 0.05}s both`
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = THEME.borderStrong;
                e.currentTarget.style.boxShadow = "0 20px 40px -20px rgba(255,255,255,0.08)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = THEME.border;
                e.currentTarget.style.boxShadow = "none";
              }}
            >
              <div
                className="w-12 h-12 rounded-lg flex items-center justify-center mb-5 transition-all duration-300 group-hover:scale-110"
                style={{ background: THEME.bgPanel, color: THEME.text }}
              >
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d={item.path} />
                </svg>
              </div>
              <h3 className="text-xl font-bold mb-2" style={{ color: THEME.text }}>
                {item.title}
              </h3>
              <p className="text-xs sm:text-sm font-mono mb-3" style={{ color: THEME.warn }}>
                {item.pain}
              </p>
              <p className="text-sm leading-relaxed" style={{ color: THEME.textDim }}>
                {item.solution}
              </p>
            </div>
          ))}
        </div>
      </div>

      <style jsx>{`
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(30px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </section>
  );
}
