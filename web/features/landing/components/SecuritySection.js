"use client";

import { useEffect, useRef, useState } from "react";
import { THEME } from "../constants/landingConfig";
import { useTheme } from "@/shared/theme/ThemeProvider";

let mermaidPromise = null;
function loadMermaid() {
  if (!mermaidPromise) mermaidPromise = import("mermaid").then((m) => m.default);
  return mermaidPromise;
}

const FLOW_DIAGRAM = `
sequenceDiagram
    autonumber
    participant Client as Mobile / Web Client
    participant Server as 9Remote Signaling Relay
    participant Host as Host Machine (Agent)

    Host->>Server: 1. Register HEAD (TAIL stays private on Host)
    Client->>Server: 2. Request Host lookup with HEAD
    Server-->>Client: 3. Return Host Public Key (Relay steps aside)
    Note over Client,Host: Direct P2P Connection (WebRTC DataChannel)
    Client->>Host: 4. Send encrypted TAIL (X25519 + AES-GCM)
    Note over Host: Host verifies TAIL secret
    Host-->>Host: 5. Physical Security Prompt: "Approve Device?"
    Note over Host: You click Approve on host screen
    Host-->>Client: 6. Secure P2P Session Established (<20ms latency)
`;

const SECURITY_PILLARS = [
  {
    step: "01",
    title: "Split-Key Zero-Trust",
    desc: "The pairing key is split into HEAD and TAIL. The relay server only sees HEAD to broker the WebRTC handshake and never receives or knows your secret TAIL.",
    iconPath: "M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
  },
  {
    step: "02",
    title: "Direct P2P Verification",
    desc: "Clients connect directly to your machine via WebRTC. Your secret TAIL is sealed with the host's public key (X25519 + AES-256-GCM) — unreadable to any intermediate relay.",
    iconPath: "M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
  },
  {
    step: "03",
    title: "Physical Host Approval",
    desc: "Even if someone knows your key, new devices cannot access your machine until you physically click 'Approve' on your computer screen.",
    iconPath: "M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
  }
];

const NODE_ICONS = {
  Client: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2.2"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>`,
  Server: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2.2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>`,
  Host: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`
};

export default function SecuritySection() {
  const { theme } = useTheme();
  const [svg, setSvg] = useState("");
  const containerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    loadMermaid()
      .then(async (mermaid) => {
        if (cancelled) return;
        mermaid.initialize({
          startOnLoad: false,
          theme: theme === "dark" ? "dark" : "neutral",
          securityLevel: "loose",
          sequence: {
            useMaxWidth: true,
            showSequenceNumbers: true,
            actorFontSize: 13,
            messageFontSize: 12,
            noteFontSize: 12
          }
        });

        try {
          const id = `security-flow-${Date.now()}`;
          const { svg: rendered } = await mermaid.render(id, FLOW_DIAGRAM);
          if (cancelled) return;
          setSvg(rendered);
        } catch {
          // Keep clean fallback if render fails
        }
      })
      .catch(() => {
        // Ignored
      });

    return () => {
      cancelled = true;
    };
  }, [theme]);

  // Inject SVG vector icons into Mermaid participant rectangle boxes
  useEffect(() => {
    if (!svg || !containerRef.current) return;
    const container = containerRef.current;
    const textElements = container.querySelectorAll("text");

    textElements.forEach((textEl) => {
      const text = textEl.textContent?.trim() || "";
      let icon = null;
      if (text.includes("Mobile / Web Client")) {
        icon = NODE_ICONS.Client;
      } else if (text.includes("9Remote Signaling Relay")) {
        icon = NODE_ICONS.Server;
      } else if (text.includes("Host Machine (Agent)")) {
        icon = NODE_ICONS.Host;
      }

      if (!icon) return;

      const parentG = textEl.parentElement;
      const rect = parentG?.querySelector("rect") || textEl.previousElementSibling;
      if (!rect || rect.tagName !== "rect") return;

      // Prevent duplicate injection
      if (parentG.querySelector("foreignObject")) return;

      const x = rect.getAttribute("x");
      const y = rect.getAttribute("y");
      const width = rect.getAttribute("width");
      const height = rect.getAttribute("height");
      if (!x || !y || !width || !height) return;

      const fo = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
      fo.setAttribute("x", x);
      fo.setAttribute("y", y);
      fo.setAttribute("width", width);
      fo.setAttribute("height", height);
      fo.style.pointerEvents = "none";
      fo.innerHTML = `
        <div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;gap:6px;font-family:ui-monospace,monospace;font-size:12px;font-weight:600;color:currentColor;">
          <span style="display:flex;align-items:center;opacity:0.9;">${icon}</span>
          <span>${text}</span>
        </div>
      `;

      textEl.style.display = "none";
      parentG.appendChild(fo);
    });
  }, [svg]);

  return (
    <section id="security" className="relative py-24 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <div
            className="inline-flex items-center gap-2 px-3 py-1 rounded-full border mb-4 text-xs font-mono"
            style={{ borderColor: THEME.border, background: THEME.bgPanel, color: THEME.textDim }}
          >
            Zero-Trust Architecture
          </div>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-4" style={{ color: THEME.text }}>
            3-Layer Security & <span style={{ color: THEME.text }}>Zero-Trust Verification</span>
          </h2>
          <p className="text-base sm:text-lg max-w-2xl mx-auto" style={{ color: THEME.textDim }}>
            Split-Key pairing, direct WebRTC encryption, and physical host approval — your machine stays completely protected.
          </p>
        </div>

        {/* Mermaid Sequence Flow Diagram */}
        <div
          className="p-4 sm:p-8 rounded-xl border mb-12 overflow-x-auto flex justify-center"
          style={{ background: THEME.bgElevated, borderColor: THEME.border }}
        >
          {!svg ? (
            <div className="py-20 text-sm font-mono" style={{ color: THEME.textDim }}>
              Loading security flow diagram...
            </div>
          ) : (
            <div
              ref={containerRef}
              className="w-full max-w-4xl min-w-[320px] [&_svg]:w-full [&_svg]:h-auto"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          )}
        </div>

        {/* 3 Clear Pillars */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {SECURITY_PILLARS.map((pillar) => (
            <div
              key={pillar.step}
              className="p-6 rounded-xl border flex flex-col justify-between"
              style={{ background: THEME.bgElevated, borderColor: THEME.border }}
            >
              <div>
                <div className="flex items-center justify-between mb-4">
                  <div
                    className="w-9 h-9 rounded-lg flex items-center justify-center border"
                    style={{ borderColor: THEME.border, background: THEME.bgPanel, color: THEME.accent }}
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d={pillar.iconPath} />
                    </svg>
                  </div>
                  <span className="text-xs font-mono" style={{ color: THEME.accent }}>
                    STEP {pillar.step}
                  </span>
                </div>
                <h3 className="text-lg font-bold mb-2" style={{ color: THEME.text }}>
                  {pillar.title}
                </h3>
              </div>
              <p className="text-sm leading-relaxed" style={{ color: THEME.textDim }}>
                {pillar.desc}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
