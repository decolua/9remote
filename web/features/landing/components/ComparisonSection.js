"use client";

import { THEME } from "../constants/landingConfig";

const FEATURES = [
  { name: "Zero Config", nine: true, claude: true, teamviewer: true, chrome: true, termius: false },
  { name: "Terminal Access", nine: true, claude: true, teamviewer: false, chrome: false, termius: true },
  { name: "Remote Desktop", nine: true, claude: false, teamviewer: true, chrome: true, termius: false },
  { name: "File Explorer", nine: true, claude: false, teamviewer: true, chrome: false, termius: true },
  { name: "Code Editor", nine: true, claude: false, teamviewer: false, chrome: false, termius: false },
  { name: "Git Integration", nine: true, claude: false, teamviewer: false, chrome: false, termius: false },
  { name: "Mobile Optimized", nine: true, claude: true, teamviewer: false, chrome: false, termius: true },
  { name: "Browser-Based", nine: true, claude: true, teamviewer: false, chrome: true, termius: false },
  { name: "QR Login", nine: true, claude: true, teamviewer: false, chrome: false, termius: false },
  { name: "Auto Tunnel", nine: true, claude: true, teamviewer: true, chrome: true, termius: false },
  { name: "Persistent Sessions", nine: true, claude: true, teamviewer: false, chrome: false, termius: true },
  { name: "Multi-Device Sync", nine: true, claude: true, teamviewer: true, chrome: false, termius: true },
  { name: "Push Notifications", nine: true, claude: true, teamviewer: false, chrome: false, termius: false },
  { name: "AI Integration", nine: true, claude: true, teamviewer: false, chrome: false, termius: false },
  { name: "No Port Forwarding", nine: true, claude: true, teamviewer: true, chrome: true, termius: false },
  { name: "No Account Required", nine: true, claude: false, teamviewer: false, chrome: false, termius: false }
];

const PRODUCTS = [
  { key: "nine", name: "9Remote", highlight: true },
  { key: "claude", name: "Claude Remote" },
  { key: "teamviewer", name: "TeamViewer" },
  { key: "chrome", name: "Chrome Remote" },
  { key: "termius", name: "Termius" }
];

function Icon({ ok }) {
  return ok ? (
    <svg className="w-3.5 h-3.5 sm:w-5 sm:h-5 mx-auto" fill="currentColor" viewBox="0 0 20 20" style={{ color: THEME.success }}>
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
    </svg>
  ) : (
    <svg className="w-3.5 h-3.5 sm:w-5 sm:h-5 mx-auto" fill="currentColor" viewBox="0 0 20 20" style={{ color: "#4A4A4A" }}>
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
    </svg>
  );
}

export default function ComparisonSection() {
  return (
    <section className="relative py-24 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-14">
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-4" style={{ color: THEME.text }}>
            Why Choose <span style={{ color: THEME.accent }}>9Remote?</span>
          </h2>
          <p className="text-lg max-w-2xl mx-auto" style={{ color: THEME.textDim }}>
            Compare features with other remote access solutions
          </p>
        </div>

        <div className="overflow-x-auto rounded-2xl border" style={{ background: THEME.bgElevated, borderColor: THEME.border }}>
          <table className="min-w-full">
            <thead>
              <tr style={{ borderBottom: `1px solid ${THEME.border}` }}>
                <th className="px-2.5 sm:px-4 py-2.5 sm:py-4 text-left text-[11px] sm:text-sm font-semibold sticky left-0 z-10 min-w-[110px] sm:min-w-[140px]"
                  style={{ color: THEME.text, background: THEME.bgElevated }}>
                  Feature
                </th>
                {PRODUCTS.map((p) => (
                  <th
                    key={p.key}
                    className="px-2 sm:px-4 py-2.5 sm:py-4 text-center text-[11px] sm:text-sm font-semibold min-w-[72px] sm:min-w-[110px]"
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
              {FEATURES.map((feature, idx) => (
                <tr
                  key={feature.name}
                  className="transition-colors"
                  style={{ borderBottom: idx < FEATURES.length - 1 ? `1px solid ${THEME.border}` : "none" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.02)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <td
                    className="px-2.5 sm:px-4 py-2 sm:py-3 text-[11px] sm:text-sm font-medium sticky left-0 z-10"
                    style={{ color: THEME.text, background: THEME.bgElevated }}
                  >
                    {feature.name}
                  </td>
                  {PRODUCTS.map((p) => (
                    <td
                      key={p.key}
                      className="px-2 sm:px-4 py-2 sm:py-3 text-center"
                      style={{ background: p.highlight ? THEME.accentSoft : "transparent" }}
                    >
                      <Icon ok={feature[p.key]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-10 text-center">
          <div
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border"
            style={{ background: THEME.accentSoft, borderColor: THEME.borderAccent }}
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20" style={{ color: THEME.accent }}>
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            <span className="font-semibold text-sm" style={{ color: THEME.accent }}>
              9Remote: All-in-one · 16/16 features
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
