"use client";

import { THEME } from "../constants/landingConfig";

const SUPERPOWERS = [
  {
    title: "Full-Featured Remote IDE",
    tag: "All-In-One",
    desc: "Your entire desktop coding setup — multi-pane terminal, code editor, Git diffs, and live AI tools — right in your pocket.",
    path: "M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
  },
  {
    title: "Code on Mobile, Web & Any Screen",
    tag: "Any Device",
    desc: "The smoothest on-the-go dev experience. Touch-optimized with dedicated dev keys, tactile haptics, and zero lag.",
    path: "M12 18h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"
  },
  {
    title: "Instant Remote Desktop",
    tag: "Smooth & Fast",
    desc: "Take full control of your PC or Mac from anywhere. Silky smooth 60fps, crystal clear, and battery friendly.",
    path: "M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
  },
  {
    title: "Visual File Explorer",
    tag: "Effortless",
    desc: "Browse, search, and edit project files with simple taps — no more wrestling with terminal paths.",
    path: "M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
  },
  {
    title: "Live Remote Emulator",
    tag: "Mobile Dev",
    desc: "Test and interact with your running iOS and Android mobile apps directly from your phone screen.",
    path: "M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
  },
  {
    title: "Instant Localhost Preview",
    tag: "One Click",
    desc: "View your live web app on your phone browser the moment you hit save — zero configuration needed.",
    path: "M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
  },
  {
    title: "Unbreakable Sessions",
    tag: "Never Stops",
    desc: "Switch apps, take phone calls, or change Wi-Fi — your running builds and servers never get interrupted.",
    path: "M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
  },
  {
    title: "100% Private & In Your Hands",
    tag: "Self-Hosted",
    desc: "Your code never leaves your computer. No cloud servers, no subscriptions, and total privacy.",
    path: "M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
  }
];

const COMPARISON_FEATURES = [
  { name: "Zero Config", nine: true, claude: true, teamviewer: true, chrome: true, termius: false },
  { name: "Remote IDE", nine: true, claude: false, teamviewer: false, chrome: false, termius: false },
  { name: "Terminal Access", nine: true, claude: true, teamviewer: false, chrome: false, termius: true },
  { name: "Persistent Daemon", nine: true, claude: true, teamviewer: false, chrome: false, termius: true },
  { name: "Remote Localhost Preview", nine: true, claude: false, teamviewer: false, chrome: false, termius: false },
  { name: "Touch File Explorer & Editor", nine: true, claude: false, teamviewer: true, chrome: false, termius: true },
  { name: "Remote Desktop", nine: true, claude: false, teamviewer: true, chrome: true, termius: false },
  { name: "Remote Emulator", nine: true, claude: false, teamviewer: false, chrome: false, termius: false },
  { name: "AI Agent Artifacts", nine: true, claude: true, teamviewer: false, chrome: false, termius: false },
  { name: "Physical Host Approval", nine: true, claude: false, teamviewer: true, chrome: false, termius: false },
  { name: "Git Integration", nine: true, claude: false, teamviewer: false, chrome: false, termius: false },
  { name: "Mobile Optimized", nine: true, claude: true, teamviewer: false, chrome: false, termius: true },
  { name: "Browser-Based", nine: true, claude: true, teamviewer: false, chrome: true, termius: false },
  { name: "QR Login", nine: true, claude: true, teamviewer: false, chrome: false, termius: false },
  { name: "Auto Tunnel", nine: true, claude: true, teamviewer: true, chrome: true, termius: false },
  { name: "No Port Forwarding", nine: true, claude: true, teamviewer: true, chrome: true, termius: false },
  { name: "No Account Required", nine: true, claude: false, teamviewer: false, chrome: false, termius: false },
  { name: "Free & Open Source", nine: true, claude: false, teamviewer: false, chrome: true, termius: false }
];

const PRODUCTS = [
  { key: "nine", name: "9Remote", highlight: true },
  { key: "claude", name: "Claude Remote" },
  { key: "teamviewer", name: "TeamViewer" },
  { key: "chrome", name: "Chrome Remote" },
  { key: "termius", name: "Termius" }
];

function CheckIcon({ ok }) {
  return ok ? (
    <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4 mx-auto" fill="currentColor" viewBox="0 0 20 20" style={{ color: THEME.success }}>
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
    </svg>
  ) : (
    <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4 mx-auto" fill="currentColor" viewBox="0 0 20 20" style={{ color: THEME.textMuted }}>
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
    </svg>
  );
}

export default function FeaturesSection() {
  return (
    <section id="features" className="relative py-24 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        {/* Section Header */}
        <div className="text-center mb-16">
          <div
            className="inline-flex items-center gap-2 px-3 py-1 mb-4 rounded-full border text-xs font-mono"
            style={{ borderColor: THEME.border, background: THEME.bgPanel, color: THEME.accent }}
          >
            All-in-one Dev Suite
          </div>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-4" style={{ color: THEME.text }}>
            Why Choose <span style={{ color: THEME.text }}>9Remote?</span>
          </h2>
          <p className="text-base sm:text-lg max-w-2xl mx-auto" style={{ color: THEME.textDim }}>
            Code from anywhere on Earth. All your development superpowers, unified in one zero-config, ultra-low latency suite.
          </p>
        </div>

        {/* 8 Feature Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-20">
          {SUPERPOWERS.map((item, index) => (
            <div
              key={item.title}
              className="group relative p-6 rounded-xl border flex flex-col justify-between transition-all duration-300 hover:-translate-y-1"
              style={{
                background: THEME.bgElevated,
                borderColor: THEME.border,
                animation: `fadeInUp 0.4s ease-out ${index * 0.04}s both`
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
              <div>
                <div className="flex items-center justify-between mb-4">
                  <div
                    className="w-10 h-10 rounded-lg flex items-center justify-center transition-all duration-300 group-hover:scale-110"
                    style={{ background: THEME.bgPanel, color: THEME.text }}
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d={item.path} />
                    </svg>
                  </div>
                  <span
                    className="text-[11px] font-mono px-2 py-0.5 rounded border"
                    style={{ borderColor: THEME.border, background: THEME.bgPanel, color: THEME.textDim }}
                  >
                    {item.tag}
                  </span>
                </div>

                <h3 className="text-lg font-bold mb-2" style={{ color: THEME.text }}>
                  {item.title}
                </h3>
              </div>

              <p className="text-sm leading-relaxed" style={{ color: THEME.textDim }}>
                {item.desc}
              </p>
            </div>
          ))}
        </div>

        {/* Feature Comparison Matrix */}
        <div className="pt-8">
          <div className="text-center mb-10">
            <h3 className="text-2xl sm:text-3xl font-bold mb-2" style={{ color: THEME.text }}>
              How 9Remote Compares
            </h3>
            <p className="text-sm sm:text-base max-w-xl mx-auto" style={{ color: THEME.textDim }}>
              Built from scratch for modern developers who need both power and mobility.
            </p>
          </div>

          <div className="overflow-x-auto rounded-2xl border" style={{ background: THEME.bgElevated, borderColor: THEME.border }}>
            <table className="min-w-full">
              <thead>
                <tr style={{ borderBottom: `1px solid ${THEME.border}` }}>
                  <th
                    className="px-3 sm:px-4 py-3 sm:py-4 text-left text-xs sm:text-sm font-semibold sticky left-0 z-10 min-w-[140px] sm:min-w-[200px]"
                    style={{ color: THEME.text, background: THEME.bgElevated }}
                  >
                    Feature
                  </th>
                  {PRODUCTS.map((p) => (
                    <th
                      key={p.key}
                      className="px-2 sm:px-4 py-3 sm:py-4 text-center text-xs sm:text-sm font-semibold min-w-[80px] sm:min-w-[110px]"
                      style={{
                        color: p.highlight ? THEME.accent : THEME.text,
                        background: p.highlight ? THEME.accentSoft : "transparent"
                      }}
                    >
                      {p.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARISON_FEATURES.map((feature, idx) => (
                  <tr
                    key={feature.name}
                    className="transition-colors"
                    style={{ borderBottom: idx < COMPARISON_FEATURES.length - 1 ? `1px solid ${THEME.border}` : "none" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = THEME.bgPanel)}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <td
                      className="px-3 sm:px-4 py-2.5 sm:py-3 text-xs sm:text-sm font-medium sticky left-0 z-10"
                      style={{ color: THEME.text, background: THEME.bgElevated }}
                    >
                      {feature.name}
                    </td>
                    {PRODUCTS.map((p) => (
                      <td
                        key={p.key}
                        className="px-2 sm:px-4 py-2.5 sm:py-3 text-center"
                        style={{ background: p.highlight ? THEME.accentSoft : "transparent" }}
                      >
                        <CheckIcon ok={feature[p.key]} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-8 text-center">
            <div
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full border text-xs sm:text-sm"
              style={{ background: THEME.bgPanel, borderColor: THEME.border }}
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20" style={{ color: THEME.success }}>
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <span className="font-semibold" style={{ color: THEME.text }}>
                9Remote: Complete 18/18 capabilities · 100% self-hosted & private
              </span>
            </div>
          </div>
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
