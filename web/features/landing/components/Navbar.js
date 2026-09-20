"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { THEME } from "../constants/landingConfig";
import ThemeToggle from "@/shared/theme/ThemeToggle";
import { useGithubStars } from "@/shared/hooks/useGithubStars";

const LINKS = [
  { href: "#features", label: "Features" },
  { href: "#security", label: "Security" },
  { href: "#how-it-works", label: "How It Works" },
  { href: "https://docs.9remote.cc/", label: "Docs", external: true },
  { href: "https://github.com/decolua/9remote", label: "GitHub", external: true }
];

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { formattedStars } = useGithubStars();
  const version = process.env.NEXT_PUBLIC_SERVER_VERSION;

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <nav
      className="fixed top-0 left-0 right-0 z-50 transition-all duration-300"
      style={{
        background: scrolled ? "color-mix(in srgb, var(--color-bg) 75%, transparent)" : "transparent",
        backdropFilter: scrolled ? "blur(16px)" : "none",
        borderBottom: scrolled ? `1px solid ${THEME.border}` : "1px solid transparent"
      }}
    >
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-3 group">
          <img
            src="/icon-192.png"
            alt="9Remote Logo"
            className="w-8 h-8 rounded-lg object-contain shadow-md shadow-brand-500/20"
          />
          <span className="text-xl font-bold tracking-tight" style={{ color: THEME.text }}>9Remote</span>
          {version && (
            <span className="px-2 py-0.5 text-xs font-mono font-medium rounded-full bg-brand-500/10 text-brand-400 border border-brand-500/20">
              v{version}
            </span>
          )}
        </Link>

        <div className="hidden md:flex items-center gap-7">
          {LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              target={l.external ? "_blank" : undefined}
              rel={l.external ? "noopener noreferrer" : undefined}
              className="text-sm transition-colors flex items-center gap-1.5"
              style={{ color: THEME.textDim }}
              onMouseEnter={(e) => (e.currentTarget.style.color = THEME.text)}
              onMouseLeave={(e) => (e.currentTarget.style.color = THEME.textDim)}
            >
              <span>{l.label}</span>
              {l.label === "GitHub" && formattedStars && (
                <span className="text-[11px] font-mono px-1.5 py-0.5 rounded-full border border-border-subtle bg-surface-2/80 text-text">
                  ★ {formattedStars}
                </span>
              )}
            </a>
          ))}
        </div>

        <div className="hidden md:flex items-center gap-3">
          <ThemeToggle />
          <a
            href="#how-it-works"
            className="px-4 py-2 rounded-lg font-semibold text-sm border transition-transform hover:scale-[1.03]"
            style={{ background: THEME.bgPanel, borderColor: THEME.border, color: THEME.text }}
          >
            <span>Download Host</span>
          </a>
          <Link
            href="/login"
            className="btn-cta px-5 py-2 rounded-lg font-semibold text-sm transition-transform hover:scale-[1.03]"
            style={{ background: "var(--color-text)", color: "var(--color-bg)" }}
          >
            <span>Remote</span>
          </Link>
        </div>

        <div className="md:hidden flex items-center gap-1.5">
          <ThemeToggle />
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="p-2"
            style={{ color: THEME.text }}
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              {mobileMenuOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>
        </div>
      </div>

      {mobileMenuOpen && (
        <div
          className="md:hidden"
          style={{ background: "color-mix(in srgb, var(--color-bg) 95%, transparent)", backdropFilter: "blur(16px)", borderTop: `1px solid ${THEME.border}` }}
        >
          <div className="flex flex-col gap-4 p-6">
            {LINKS.map((l) => (
              <a
                key={l.label}
                href={l.href}
                target={l.external ? "_blank" : undefined}
                rel={l.external ? "noopener noreferrer" : undefined}
                onClick={() => setMobileMenuOpen(false)}
                className="text-sm flex items-center justify-between"
                style={{ color: THEME.textDim }}
              >
                <span>{l.label}</span>
                {l.label === "GitHub" && formattedStars && (
                  <span className="text-xs font-mono px-2 py-0.5 rounded-full border border-border-subtle bg-surface-2 text-text">
                    ★ {formattedStars}
                  </span>
                )}
              </a>
            ))}
            <a
              href="#how-it-works"
              onClick={() => setMobileMenuOpen(false)}
              className="px-6 py-2 rounded-lg font-semibold text-sm text-center border"
              style={{ background: THEME.bgPanel, borderColor: THEME.border, color: THEME.text }}
            >
              Download Host
            </a>
            <Link
              href="/login"
              className="px-6 py-2 rounded-lg font-semibold text-sm text-center"
              style={{ background: "var(--color-text)", color: "var(--color-bg)" }}
            >
              Remote
            </Link>
          </div>
        </div>
      )}
    </nav>
  );
}
