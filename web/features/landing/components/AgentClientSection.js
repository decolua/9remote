"use client";

import { Fragment } from "react";
import { THEME, HALVES } from "../constants/landingConfig";

export default function AgentClientSection() {
  return (
    <section id="how-it-works" className="relative py-24 px-4 sm:px-6 lg:px-8">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-14">
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-3" style={{ color: THEME.text }}>
            Two halves. One session.
          </h2>
          <p className="text-base sm:text-lg max-w-2xl mx-auto" style={{ color: THEME.textDim }}>
            The agent stays with your code. The client goes wherever you are. They talk directly —
            no relay, no cloud middleman.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-4 md:gap-6 items-center">
          {HALVES.map((half, i) => (
            <Fragment key={half.role}>
              {i === 1 && (
                <div className="flex md:flex-col items-center justify-center gap-2 py-2 md:py-0">
                  <span
                    className="text-[11px] font-mono px-2 py-0.5 rounded border whitespace-nowrap"
                    style={{ borderColor: THEME.border, background: THEME.bgPanel, color: THEME.accent }}
                  >
                    WebRTC
                  </span>
                  <svg
                    className="w-6 h-6 rotate-90 md:rotate-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    style={{ color: THEME.textMuted }}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4 12h16m0 0l-6-6m6 6l-6 6" />
                  </svg>
                </div>
              )}
              <div
                className="p-6 sm:p-7 rounded-2xl border h-full transition-all duration-300 hover:-translate-y-1"
                style={{ background: THEME.bgElevated, borderColor: THEME.border }}
              >
                <div className="flex items-center gap-3 mb-1">
                  <span
                    className="text-[11px] font-mono font-bold px-2 py-0.5 rounded border uppercase tracking-wider"
                    style={{ borderColor: THEME.border, background: THEME.bgPanel, color: THEME.accent }}
                  >
                    {half.role}
                  </span>
                </div>
                <h3 className="text-lg font-bold mb-4" style={{ color: THEME.text }}>
                  {half.tagline}
                </h3>
                <ul className="flex flex-col gap-2.5">
                  {half.points.map((p) => (
                    <li key={p} className="flex items-start gap-2.5 text-sm" style={{ color: THEME.textDim }}>
                      <svg
                        className="w-4 h-4 flex-shrink-0 mt-0.5"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                        style={{ color: THEME.success }}
                      >
                        <path
                          fillRule="evenodd"
                          d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                          clipRule="evenodd"
                        />
                      </svg>
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </Fragment>
          ))}
        </div>
      </div>
    </section>
  );
}
