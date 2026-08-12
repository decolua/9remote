"use client";

import { MacbookClaudeCode, IPhoneChat, ConnectionBeam } from "./DeviceShowcase";
import { THEME } from "../constants/landingConfig";

export default function TerminalDemoSection() {
  return (
    <section
      id="terminal-demo"
      className="relative py-24 px-4 sm:px-6 lg:px-8"
    >
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-4" style={{ color: THEME.text }}>
            See It <span style={{ color: THEME.text }}>In Action</span>
          </h2>
          <p className="text-lg max-w-2xl mx-auto" style={{ color: THEME.textDim }}>
            Your Mac running Claude Code. Your phone sends prompts. Real time.
          </p>
        </div>

        <div className="relative grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-12 lg:gap-20 items-center justify-items-center">
          <div className="w-full flex justify-center lg:justify-end">
            <MacbookClaudeCode />
          </div>

          <ConnectionBeam />

          <div className="flex justify-center lg:justify-start">
            <IPhoneChat />
          </div>
        </div>

        <div className="mt-16 grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { step: "01", title: "Run on Mac", desc: "Start Claude Code and 9remote locally" },
            { step: "02", title: "Scan QR", desc: "Connect phone via secure tunnel" },
            { step: "03", title: "Prompt from anywhere", desc: "Type on phone, code runs on Mac" }
          ].map((s) => (
            <div
              key={s.step}
              className="p-5 rounded-xl border"
              style={{ background: THEME.bg, borderColor: THEME.border }}
            >
              <div className="text-xs font-mono mb-2" style={{ color: THEME.textDim }}>{s.step}</div>
              <div className="font-semibold mb-1" style={{ color: THEME.text }}>{s.title}</div>
              <div className="text-sm" style={{ color: THEME.textDim }}>{s.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
