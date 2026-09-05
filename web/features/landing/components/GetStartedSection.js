"use client";

import { useState } from "react";
import { THEME } from "../constants/landingConfig";

const STEPS = [
  {
    num: "01",
    title: "Run on your computer",
    desc: "Open your terminal on macOS, Linux, or Windows. Run one command — no global installation required.",
    command: "npx 9remote"
  },
  {
    num: "02",
    title: "Scan QR code or click link",
    desc: "Your terminal prints a secure QR code and pairing link. Scan it with your phone or open it in any browser.",
    highlight: "Works instantly on iOS, Android, tablets, and other PCs."
  },
  {
    num: "03",
    title: "Approve device & start coding",
    desc: "Click 'Approve' once on your host screen. Your direct WebRTC session is established with full IDE, files, and desktop access.",
    highlight: "Zero-trust safety: only physically approved devices can connect."
  }
];

export default function GetStartedSection() {
  const [copied, setCopied] = useState(false);

  const copyCommand = () => {
    navigator.clipboard?.writeText("npx 9remote").catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section id="get-started" className="relative py-24 px-4 sm:px-6 lg:px-8">
      <div className="max-w-5xl mx-auto">
        <div className="relative rounded-2xl p-6 sm:p-12 overflow-hidden">
          <div
            className="absolute -top-24 -right-24 w-80 h-80 rounded-full pointer-events-none animate-pulse-glow"
            style={{ background: "rgba(255,255,255,0.04)", filter: "blur(100px)" }}
          />

          <div className="relative">
            <div className="text-center mb-12">
              <div
                className="inline-flex items-center gap-2 px-3 py-1 mb-4 rounded-full border text-xs font-mono"
                style={{ borderColor: THEME.border, background: THEME.bgPanel, color: THEME.accent }}
              >
                Zero-Config Setup
              </div>
              <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-3" style={{ color: THEME.text }}>
                Get Started in <span style={{ color: THEME.text }}>30 Seconds</span>
              </h2>
              <p className="text-base sm:text-lg max-w-xl mx-auto" style={{ color: THEME.textDim }}>
                No signups, no cloud accounts, no port forwarding. Start coding on your phone in three easy steps.
              </p>
            </div>

            {/* 3 Step Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
              {STEPS.map((step) => (
                <div
                  key={step.num}
                  className="p-6 rounded-xl border flex flex-col justify-between relative transition-all duration-300 hover:-translate-y-1"
                  style={{ background: THEME.bgElevated, borderColor: THEME.border }}
                >
                  <div>
                    <div className="flex items-center justify-between mb-4">
                      <span className="text-xs font-mono font-bold px-2 py-0.5 rounded border"
                        style={{ borderColor: THEME.border, background: THEME.bgPanel, color: THEME.accent }}>
                        STEP {step.num}
                      </span>
                    </div>
                    <h3 className="text-lg font-bold mb-2" style={{ color: THEME.text }}>
                      {step.title}
                    </h3>
                    <p className="text-xs sm:text-sm leading-relaxed mb-4" style={{ color: THEME.textDim }}>
                      {step.desc}
                    </p>
                  </div>

                  {step.command ? (
                    <div
                      className="p-3 rounded-lg border font-mono text-xs flex items-center justify-between gap-2"
                      style={{ background: THEME.bg, borderColor: THEME.border }}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span style={{ color: THEME.textDim }}>$</span>
                        <code style={{ color: THEME.text }} className="font-bold">{step.command}</code>
                      </div>
                      <button
                        onClick={copyCommand}
                        className="px-2 py-0.5 text-[11px] rounded border transition-colors flex-shrink-0"
                        style={{
                          background: THEME.bgPanel,
                          borderColor: THEME.border,
                          color: copied ? THEME.success : THEME.text
                        }}
                      >
                        {copied ? "✓ Copied" : "Copy"}
                      </button>
                    </div>
                  ) : (
                    <div
                      className="p-2.5 rounded-lg border text-xs font-mono"
                      style={{ background: THEME.bgPanel, borderColor: THEME.border, color: THEME.textDim }}
                    >
                      ✓ {step.highlight}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Terminal Live Output Mock */}
            <div className="rounded-xl overflow-hidden border max-w-2xl mx-auto shadow-lg" style={{ background: THEME.bg, borderColor: THEME.border }}>
              <div
                className="flex items-center gap-2 px-4 py-3 border-b"
                style={{ background: THEME.bgPanel, borderColor: THEME.border }}
              >
                <div className="flex gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#FF5F57" }} />
                  <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#FEBC2E" }} />
                  <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#28C840" }} />
                </div>
                <span className="ml-2 text-xs font-mono" style={{ color: THEME.textDim }}>host machine — terminal</span>
              </div>

              <div className="p-5 font-mono text-xs sm:text-sm leading-relaxed">
                <div className="flex items-center gap-2 mb-2">
                  <span style={{ color: THEME.textDim }}>$</span>
                  <span style={{ color: THEME.text }} className="font-bold">npx 9remote</span>
                </div>
                <div style={{ color: THEME.textDim }}>
                  <div><span style={{ color: THEME.success }}>[ok]</span> pty daemon initialized · sessions persistent</div>
                  <div><span style={{ color: THEME.success }}>[ok]</span> direct WebRTC signaling ready</div>
                  <div><span style={{ color: THEME.success }}>[ok]</span> cloudflare tunnel established: <span style={{ color: THEME.text }}>https://9remote.cc/</span></div>
                  <div className="my-2 p-2 rounded border border-dashed text-center" style={{ borderColor: THEME.border, color: THEME.text }}>
                    [ ▄▄▄▄▄▄▄ QR CODE GENERATED ▄▄▄▄▄▄▄ ]<br/>
                    <span className="text-[11px]" style={{ color: THEME.textDim }}>Scan with mobile camera or open URL with one-time code</span>
                  </div>
                  <div className="flex items-center gap-2" style={{ color: THEME.success }}>
                    <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: THEME.success }} />
                    <span>Device connected · Approved by host · Ready to code</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Metrics */}
            <div className="mt-10 grid grid-cols-3 gap-4 text-center max-w-xl mx-auto">
              {[
                { val: "30s", label: "Setup Time" },
                { val: "0", label: "Port Forwarding" },
                { val: "100%", label: "Self-Hosted" }
              ].map((s) => (
                <div
                  key={s.label}
                  className="p-4 rounded-xl border"
                  style={{ background: THEME.bgPanel, borderColor: THEME.border }}
                >
                  <div className="text-xl sm:text-2xl font-bold mb-1" style={{ color: THEME.text }}>{s.val}</div>
                  <div className="text-xs font-mono" style={{ color: THEME.textDim }}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
