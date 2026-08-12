"use client";

import { useState } from "react";
import { THEME } from "../constants/landingConfig";

export default function GetStartedSection() {
  const [copied, setCopied] = useState(false);

  const copyCommand = () => {
    navigator.clipboard?.writeText("npm install -g 9remote").catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section id="get-started" className="relative py-24 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        <div
          className="relative rounded-2xl p-8 sm:p-12 overflow-hidden"
        >
          <div
            className="absolute -top-24 -right-24 w-80 h-80 rounded-full pointer-events-none animate-pulse-glow"
            style={{ background: "rgba(255,255,255,0.04)", filter: "blur(100px)" }}
          />

          <div className="relative">
            <div className="text-center mb-8">
              <h2 className="text-3xl sm:text-4xl font-bold mb-3" style={{ color: THEME.text }}>
                Get Started in <span style={{ color: THEME.text }}>Seconds</span>
              </h2>
              <p className="text-base" style={{ color: THEME.textDim }}>
                Install 9Remote and start accessing your terminal remotely
              </p>
            </div>

            <div className="rounded-lg overflow-hidden border" style={{ background: THEME.bg, borderColor: THEME.border }}>
              <div
                className="flex items-center gap-2 px-4 py-3 border-b"
                style={{ background: THEME.bgPanel, borderColor: THEME.border }}
              >
                <div className="flex gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#FF5F57" }} />
                  <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#FEBC2E" }} />
                  <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#28C840" }} />
                </div>
                <span className="ml-2 text-xs font-mono" style={{ color: THEME.textDim }}>terminal</span>
              </div>

              <div className="p-6 font-mono text-sm">
                <div className="flex items-center gap-2 mb-4">
                  <span style={{ color: THEME.textDim }}>$</span>
                  <span style={{ color: THEME.text }}>npm install -g 9remote</span>
                  <button
                    onClick={copyCommand}
                    className="ml-auto px-3 py-1 text-xs rounded transition-colors"
                    style={{
                      background: copied ? THEME.bgPanel : THEME.bgPanel,
                      color: copied ? THEME.success : THEME.textDim,
                      border: `1px solid ${THEME.border}`
                    }}
                  >
                    {copied ? "✓ Copied" : "Copy"}
                  </button>
                </div>

                <div className="mb-4" style={{ color: THEME.textDim }}>
                  <div className="mb-1"><span style={{ color: THEME.textDim }}>→</span> Installing 9remote...</div>
                  <div className="mb-1"><span style={{ color: THEME.success }}>✓</span> Installation complete</div>
                </div>

                <div className="pt-4 mb-4 border-t" style={{ borderColor: THEME.border }}>
                  <div className="flex items-center gap-2 mb-2">
                    <span style={{ color: THEME.textDim }}>$</span>
                    <span style={{ color: THEME.text }}>9remote</span>
                  </div>
                </div>

                <div style={{ color: THEME.textDim }}>
                  <div className="mb-1"><span style={{ color: THEME.textDim }}>→</span> Starting server...</div>
                  <div className="mb-1"><span style={{ color: THEME.textDim }}>→</span> Creating tunnel...</div>
                  <div className="mb-1"><span style={{ color: THEME.success }}>✓</span> Server running on <span style={{ color: THEME.text }}>http://localhost:3000</span></div>
                  <div className="mb-1"><span style={{ color: THEME.success }}>✓</span> Tunnel ready: <span style={{ color: THEME.text }}>https://xxx.trycloudflare.com</span></div>
                  <div className="mt-3 flex items-center gap-2" style={{ color: THEME.textDim }}>
                    <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: THEME.accent }} />
                    Scan QR code to connect
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-8 grid grid-cols-3 gap-4 text-center">
              {[
                { val: "30s", label: "Setup Time" },
                { val: "0", label: "Configuration" },
                { val: "∞", label: "Possibilities" }
              ].map((s) => (
                <div
                  key={s.label}
                  className="p-4 rounded-lg border"
                  style={{ background: THEME.bgPanel, borderColor: THEME.border }}
                >
                  <div className="text-2xl font-bold mb-1" style={{ color: THEME.text }}>{s.val}</div>
                  <div className="text-xs" style={{ color: THEME.textDim }}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
