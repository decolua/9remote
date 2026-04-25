"use client";

import Link from "next/link";
import { THEME } from "../constants/landingConfig";

export default function CTASection() {
  return (
    <section className="relative py-24 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto text-center">
        <div className="relative">
          <div
            className="absolute inset-0 blur-3xl pointer-events-none animate-pulse-glow"
            style={{ background: THEME.accentSoft }}
          />

          <div className="relative">
            <h2
              className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-5"
              style={{ color: THEME.text }}
            >
              Work anywhere with just your <span style={{ color: THEME.accent }}>phone</span>
            </h2>

            <p className="text-lg sm:text-xl mb-8 max-w-2xl mx-auto" style={{ color: THEME.textDim }}>
              Free. Open source. Ready in 30 seconds.
            </p>

            <div className="flex flex-row gap-2.5 sm:gap-3 justify-center items-center flex-wrap">
              <Link
                href="/login"
                className="btn-cta group px-5 sm:px-8 py-3 sm:py-4 rounded-lg font-semibold text-sm sm:text-base transition-transform duration-300 hover:scale-[1.03]"
                style={{ background: THEME.accent, color: "#FFF" }}
              >
                <span className="flex items-center justify-center gap-2">
                  Get Remote
                  <svg className="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                  </svg>
                </span>
              </Link>

              <a
                href="https://github.com/decolua/9remote"
                target="_blank"
                rel="noopener noreferrer"
                className="px-5 sm:px-8 py-3 sm:py-4 rounded-lg font-semibold text-sm sm:text-base transition-all duration-300 hover:scale-[1.03] flex items-center justify-center gap-2 border"
                style={{ background: THEME.bgPanel, color: THEME.text, borderColor: THEME.border }}
              >
                <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
                </svg>
                <span>GitHub</span>
              </a>
            </div>

            <p className="mt-8 text-sm" style={{ color: THEME.textMuted }}>
              ✓ No credit card required · Open source · MIT License
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
