"use client";

import { THEME } from "../constants/landingConfig";

const FEATURES = [
  {
    title: "Code from bed",
    description: "Terminal on phone",
    path: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
  },
  {
    title: "Deploy at cafe",
    description: "No heavy laptop needed",
    path: "M21 15.546c-.523 0-1.046.151-1.5.454a2.704 2.704 0 01-3 0 2.704 2.704 0 00-3 0 2.704 2.704 0 01-3 0 2.704 2.704 0 00-3 0 2.704 2.704 0 01-3 0 2.701 2.701 0 00-1.5-.454M9 6v2m3-2v2m3-2v2M9 3h.01M12 3h.01M15 3h.01M21 21v-7a2 2 0 00-2-2H5a2 2 0 00-2 2v7h18zm-3-9v-2a2 2 0 00-2-2H8a2 2 0 00-2 2v2h12z"
  },
  {
    title: "Fix bugs anywhere",
    description: "Access from everywhere",
    path: "M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
  },
  {
    title: "Secure & fast",
    description: "Auto tunnel, <50ms",
    path: "M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
  },
  {
    title: "Simple & powerful",
    description: "Just scan QR",
    path: "M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 12h2a1 1 0 001-1v-2a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zM17 8h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1z"
  },
  {
    title: "Light & smooth",
    description: "No lag, no freeze",
    path: "M13 10V3L4 14h7v7l9-11h-7z"
  }
];

export default function FeaturesSection() {
  return (
    <section id="features" className="relative py-24 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-4" style={{ color: THEME.text }}>
            Powerful <span style={{ color: THEME.accent }}>Features</span>
          </h2>
          <p className="text-lg max-w-2xl mx-auto" style={{ color: THEME.textDim }}>
            Everything you need for secure remote access
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {FEATURES.map((feature, index) => (
            <div
              key={feature.title}
              className="group relative p-6 rounded-xl border transition-all duration-300 hover:-translate-y-1"
              style={{
                background: THEME.bgElevated,
                borderColor: THEME.border,
                animation: `fadeInUp 0.6s ease-out ${index * 0.08}s forwards`,
                opacity: 0
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = THEME.borderAccent;
                e.currentTarget.style.boxShadow = `0 20px 40px -20px ${THEME.accentGlow}`;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = THEME.border;
                e.currentTarget.style.boxShadow = "none";
              }}
            >
              <div
                className="w-12 h-12 rounded-lg flex items-center justify-center mb-4 transition-all duration-300 group-hover:scale-110"
                style={{ background: THEME.accentSoft, color: THEME.accent }}
              >
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d={feature.path} />
                </svg>
              </div>
              <h3 className="text-lg font-semibold mb-1.5" style={{ color: THEME.text }}>{feature.title}</h3>
              <p className="text-sm" style={{ color: THEME.textDim }}>{feature.description}</p>
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
