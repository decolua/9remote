"use client";

import { useSyncExternalStore } from "react";
import AnimatedBackground from "./AnimatedBackground";
import Navbar from "./Navbar";
import Footer from "./Footer";
import { useDesktopReleases } from "../hooks/useDesktopReleases";
import {
  THEME, INSTALLERS, DESKTOP_RELEASES, downloadUrl, detectOs, byNewest,
  GITHUB_REPO_URL, APP_STORE_URL, PLAY_STORE_URL
} from "../constants/landingConfig";

// Server + first paint use "other" so hydration matches; the real OS swaps in after mount
const useOs = () => useSyncExternalStore(() => () => {}, detectOs, () => "other");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Hand-rolled: toLocaleDateString picks a different format on the server than in the browser
const formatDate = (iso) => {
  const [y, m, d] = iso.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
};

function DownloadButton({ href, children, primary }) {
  return (
    <a
      href={href}
      className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-[13px] font-semibold border transition-transform hover:scale-[1.02] whitespace-nowrap"
      style={primary
        ? { background: "var(--color-text)", color: "var(--color-bg)", borderColor: "transparent" }
        : { background: THEME.bgPanel, color: THEME.text, borderColor: THEME.border }}
    >
      {children}
      <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" />
      </svg>
    </a>
  );
}

function InstallerCard({ installer, tag, mine }) {
  return (
    <div
      className="p-5 rounded-2xl border flex flex-col transition-all duration-300 hover:-translate-y-0.5"
      style={{
        background: THEME.bgElevated,
        borderColor: mine ? THEME.borderAccent : THEME.border
      }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-base font-bold" style={{ color: THEME.text }}>{installer.os}</span>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border" style={{ borderColor: THEME.border, color: THEME.textMuted }}>{tag}</span>
        {mine && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full border" style={{ borderColor: THEME.borderAccent, color: THEME.accent }}>
            Your system
          </span>
        )}
      </div>
      <p className="text-xs mb-4" style={{ color: THEME.textDim }}>{installer.label}</p>
      <div className="mt-auto">
        <DownloadButton href={downloadUrl(tag, installer.asset)} primary={mine}>
          Download {installer.ext}
        </DownloadButton>
      </div>
    </div>
  );
}

// macOS and Windows both ship here; an unknown OS gets no card highlighted
const isMine = (installer, os) => os !== "other" && installer.os.toLowerCase().startsWith(os);

export default function DownloadsPage() {
  const os = useOs();
  // Live list from GitHub; the hand-kept one carries the page until it arrives (or forever, offline)
  const live = useDesktopReleases();
  const releases = byNewest(live || DESKTOP_RELEASES);
  const [latest, ...older] = releases;

  return (
    <div className="min-h-screen overflow-x-hidden safe-area-insets" style={{ color: THEME.text }}>
      <AnimatedBackground />
      <div className="landing-light" aria-hidden />
      <Navbar />
      <main className="relative z-10 pt-28 pb-24 px-4 sm:px-6 lg:px-8">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-3" style={{ color: THEME.text }}>
              Download 9Remote
            </h1>
            <p className="text-base sm:text-lg max-w-xl mx-auto" style={{ color: THEME.textDim }}>
              The host app serves your terminals, screen and files. Install it on the machine you leave running.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-16">
            {INSTALLERS.map((i) => (
              <InstallerCard key={i.id} installer={i} tag={latest.tag} mine={isMine(i, os)} />
            ))}
          </div>

          <section className="mb-16">
            <h2 className="text-[11px] font-mono uppercase tracking-[0.12em] pb-2.5 mb-1 border-b" style={{ color: THEME.textMuted, borderColor: THEME.border }}>
              Older versions
            </h2>
            {older.map((rel) => (
              <div key={rel.tag} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3.5 border-b" style={{ borderColor: THEME.border }}>
                <span className="text-sm font-bold font-mono" style={{ color: THEME.text }}>{rel.tag}</span>
                <span className="text-xs" style={{ color: THEME.textMuted }}>{formatDate(rel.date)}</span>
                <div className="flex flex-wrap gap-2 ml-auto">
                  {INSTALLERS.map((i) => (
                    <a
                      key={i.id}
                      href={downloadUrl(rel.tag, i.asset)}
                      className="text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors"
                      style={{ background: THEME.bgPanel, color: THEME.textDim, borderColor: THEME.border }}
                    >
                      {i.short}
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </section>

          <section className="text-center">
            <h2 className="text-lg font-bold mb-2" style={{ color: THEME.text }}>On a phone or tablet?</h2>
            <p className="text-sm mb-4" style={{ color: THEME.textDim }}>
              9Remote is a client on mobile — pair it with a host using the QR code.
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              <a href={APP_STORE_URL} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold px-4 py-2 rounded-lg border" style={{ background: THEME.bgPanel, color: THEME.text, borderColor: THEME.border }}>
                App Store
              </a>
              <a href={PLAY_STORE_URL} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold px-4 py-2 rounded-lg border" style={{ background: THEME.bgPanel, color: THEME.text, borderColor: THEME.border }}>
                Google Play
              </a>
              <a href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold px-4 py-2 rounded-lg border" style={{ background: THEME.bgPanel, color: THEME.textDim, borderColor: THEME.border }}>
                All releases on GitHub
              </a>
            </div>
          </section>
        </div>
      </main>
      <Footer />
    </div>
  );
}
