"use client";

import { Fragment, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { THEME, HALVES, releaseFor, APP_STORE_URL, PLAY_STORE_URL } from "../constants/landingConfig";

// Enough to pick an installer; iPadOS reports as Mac, which the .dmg does not serve
function detectOs() {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return "other";
  if (/Mac/.test(ua)) return "macos";
  if (/Win/.test(ua)) return "windows";
  return "other";
}

// Mirror-tabbed cards — both halves get the same segmented control + body row
const HALF_TABS = {
  Host: [
    { id: "app", label: "App" },
    { id: "npm", label: "npm" }
  ],
  Client: [
    { id: "browser", label: "Browser" },
    { id: "desktop", label: "Desktop" },
    { id: "mobile", label: "Mobile" }
  ]
};
const defaultTab = (role) => (role === "Client" ? "browser" : "app");
const OS_LABEL = { macos: "macOS", windows: "Windows" };
const OS_EXT = { macos: "9remote.dmg", windows: "9remote.exe" };

export default function AgentClientSection() {
  const version = process.env.NEXT_PUBLIC_SERVER_VERSION;
  // Server + first paint use "other" so hydration matches; real OS swaps in after mount
  const os = useSyncExternalStore(() => () => {}, detectOs, () => "other");
  const [copied, setCopied] = useState(false);
  const [picked, setPicked] = useState({});

  const copyCommand = () => {
    navigator.clipboard?.writeText("npm i -g 9remote").catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section id="how-it-works" className="relative py-24 px-4 sm:px-6 lg:px-8">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-14">
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-3" style={{ color: THEME.text }}>
            Two halves. One session.
          </h2>
          <p className="text-base sm:text-lg max-w-xl mx-auto" style={{ color: THEME.textDim }}>
            One command on your machine — then any browser joins it. Direct connection, no relay.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-4 md:gap-6 items-stretch">
          {HALVES.map((half, i) => {
            const tabs = HALF_TABS[half.role];
            const activeTab = picked[half.role] || defaultTab(half.role);
            const select = (id) => setPicked((p) => ({ ...p, [half.role]: id }));
            return (
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
                  className="p-6 sm:p-7 rounded-2xl border flex flex-col transition-all duration-300 hover:-translate-y-1"
                  style={{ background: THEME.bgElevated, borderColor: THEME.border }}
                >
                  <div className="flex items-center gap-2 mb-3">
                    <span
                      className="text-[11px] font-mono font-bold px-2 py-0.5 rounded border uppercase tracking-wider"
                      style={{ borderColor: THEME.border, background: THEME.bgPanel, color: THEME.accent }}
                    >
                      {half.role}
                    </span>
                    {version && (
                      <span
                        className="text-[10px] font-mono px-1.5 py-0.5 rounded border"
                        style={{ borderColor: THEME.border, background: THEME.bgPanel, color: THEME.textDim }}
                      >
                        v{version}
                      </span>
                    )}
                  </div>
                  <h3 className="text-xl font-bold mb-1.5" style={{ color: THEME.text }}>
                    {half.title}
                  </h3>
                  <p className="text-sm mb-5" style={{ color: THEME.textDim }}>
                    {half.desc}
                  </p>

                  <div className="mt-auto flex flex-col items-center">
                    <div
                      className="flex gap-0.5 p-1 rounded-lg border mb-6 w-full"
                      style={{ background: THEME.bgPanel, borderColor: THEME.border }}
                    >
                      {tabs.map((t) => (
                        <button
                          key={t.id}
                          onClick={() => select(t.id)}
                          className={`flex-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${activeTab === t.id ? "" : "hover:text-text"}`}
                          style={
                            activeTab === t.id
                              ? { background: THEME.bgElevated, color: THEME.text, boxShadow: "0 1px 2px rgba(0,0,0,0.2)" }
                              : { color: THEME.textMuted }
                          }
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                    <div className="inline-block rounded-lg border overflow-hidden" style={{ borderColor: THEME.border }}>
                      {activeTab === "npm" ? (
                        <button
                          onClick={copyCommand}
                          title={copied ? "Copied" : "Copy"}
                          className="w-full flex items-center gap-2 px-3 py-1.5 font-mono text-[13px] text-left transition-colors hover:bg-surface-2"
                          style={{ background: THEME.bgPanel }}
                        >
                          <span style={{ color: THEME.textMuted }}>$</span>
                          <code className="font-bold" style={{ color: THEME.text }}>npm i -g 9remote</code>
                          <span className="ml-auto text-xs font-sans" style={{ color: copied ? THEME.success : THEME.textMuted }}>
                            {copied ? "Copied" : "Copy"}
                          </span>
                        </button>
                      ) : activeTab === "mobile" ? (
                        <div className="flex gap-2 w-full">
                          <a
                            href={APP_STORE_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-[13px] font-semibold transition-opacity hover:opacity-90 whitespace-nowrap"
                            style={{ background: "var(--color-text)", color: "var(--color-bg)" }}
                          >
                            <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.38c.62-.75 1.04-1.8 0.92-2.85-.9.04-2 .6-2.65 1.35-.58.66-1.09 1.73-.95 2.76.99.08 2.03-.51 2.68-1.26z" />
                            </svg>
                            App Store
                          </a>
                          <a
                            href={PLAY_STORE_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-[13px] font-semibold transition-opacity hover:opacity-90 whitespace-nowrap"
                            style={{ background: "var(--color-text)", color: "var(--color-bg)" }}
                          >
                            <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M3.609 1.814L13.793 12 3.61 22.186a2.128 2.128 0 0 1-.22-.964V2.778c0-.36.08-.694.22-.964zm11.233 11.234l2.584 2.584-11.834 6.83 9.25-9.414zm0-2.096L5.592 1.538l11.834 6.83-2.584 2.584zm1.485 1.048l3.633 2.098a1.328 1.328 0 0 0 0-2.296l-3.633-2.098-1.048 1.048 1.048 1.048z" />
                            </svg>
                            Google Play
                          </a>
                        </div>
                      ) : (
                        <Link
                          href={activeTab === "browser" ? "/login" : releaseFor(os)}
                          target={activeTab === "browser" ? undefined : "_blank"}
                          rel={activeTab === "browser" ? undefined : "noopener noreferrer"}
                          className="w-full flex items-center justify-center gap-2 px-4 py-1.5 text-[13px] font-semibold transition-opacity hover:opacity-90"
                          style={{ background: "var(--color-text)", color: "var(--color-bg)" }}
                        >
                          {activeTab === "browser" ? (
                            <>
                              <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-9-9m9 9H3m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9" />
                              </svg>
                              Open in Browser
                              <span className="ml-auto text-xs font-mono opacity-70">→</span>
                            </>
                          ) : (
                            <>
                              <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" />
                              </svg>
                              {activeTab === "desktop" || os === "other"
                                ? (version ? `Download v${version}` : "Download")
                                : (version ? `Download v${version} for ${OS_LABEL[os]}` : `Download for ${OS_LABEL[os]}`)}
                              {OS_EXT[os] && <span className="ml-auto text-xs font-mono opacity-70">{OS_EXT[os]}</span>}
                            </>
                          )}
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>
    </section>
  );
}
