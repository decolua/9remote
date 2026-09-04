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
    actor Client as Client (Web / Mobile)
    participant Server as 9Remote Server (Routing)
    actor Host as Your Computer (Agent)

    Host->>Server: 1. Register HEAD (TAIL stays private on Host)
    Client->>Server: 2. Send HEAD to locate Host
    Server-->>Client: 3. Return Host Public Key (Server steps aside)
    Note over Client,Host: Direct P2P Connection (WebRTC / Secure WS)
    Client->>Host: 4. Send encrypted TAIL (Sealed with Host Public Key)
    Note over Host: Host verifies secret TAIL
    Host-->>Host: 5. Prompt: "Approve this new device?"
    Note over Host: You physically click Approve on Host
    Host-->>Client: 6. Encrypted session established
`;

const SECURITY_PILLARS = [
  {
    step: "01",
    title: "Split-Key Zero-Trust",
    desc: "The connection key is split into HEAD and TAIL. The server only sees HEAD to route traffic and never receives or knows your secret TAIL."
  },
  {
    step: "02",
    title: "Direct P2P Verification",
    desc: "Clients connect directly to your machine. Your secret TAIL is sealed with the host's public key (X25519 + AES-256-GCM) — unreadable to any relay."
  },
  {
    step: "03",
    title: "Physical Host Approval",
    desc: "Even with the secret key, new devices cannot access your machine until you physically click Approve on your computer screen."
  }
];

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

  return (
    <section id="security" className="relative py-24 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <div
            className="inline-flex items-center gap-2 px-3 py-1 rounded-full border mb-4 text-xs font-mono"
            style={{ borderColor: THEME.border, background: THEME.bgPanel, color: THEME.textDim }}
          >
            Zero-Knowledge Architecture
          </div>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-4" style={{ color: THEME.text }}>
            Security That Never Trusts the Server
          </h2>
          <p className="text-lg max-w-2xl mx-auto" style={{ color: THEME.textDim }}>
            How Split-Key authentication (HEAD & TAIL) and Host Approval keep your code and machine completely protected.
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
              className="p-6 rounded-xl border"
              style={{ background: THEME.bgElevated, borderColor: THEME.border }}
            >
              <div className="text-xs font-mono mb-2" style={{ color: THEME.accent }}>
                STEP {pillar.step}
              </div>
              <h3 className="text-lg font-bold mb-2" style={{ color: THEME.text }}>
                {pillar.title}
              </h3>
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
