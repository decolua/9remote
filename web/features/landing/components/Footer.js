"use client";

import Link from "next/link";
import { THEME } from "../constants/landingConfig";

const PRODUCT_LINKS = [
  { href: "/login", label: "Remote", internal: true },
  { href: "/workspace", label: "Terminal", internal: true },
  { href: "/remote", label: "Remote Desktop", internal: true }
];

const RESOURCE_LINKS = [
  { href: "https://github.com/decolua/9remote", label: "GitHub" },
  { href: "https://www.npmjs.com/package/9remote", label: "NPM" },
  { href: "https://docs.9remote.cc/", label: "Documentation" },
  { href: "https://www.facebook.com/groups/9teamvn", label: "Community" }
];

function FooterLink({ href, label, internal }) {
  const Tag = internal ? Link : "a";
  const extra = internal ? {} : { target: "_blank", rel: "noopener noreferrer" };
  return (
    <Tag
      href={href}
      {...extra}
      className="text-sm transition-colors"
      style={{ color: THEME.textDim }}
      onMouseEnter={(e) => (e.currentTarget.style.color = THEME.accent)}
      onMouseLeave={(e) => (e.currentTarget.style.color = THEME.textDim)}
    >
      {label}
    </Tag>
  );
}

export default function Footer() {
  const version = process.env.NEXT_PUBLIC_SERVER_VERSION;

  return (
    <footer
      className="relative py-14 px-4 sm:px-6 lg:px-8 border-t"
      style={{ background: THEME.bg, borderColor: THEME.border }}
    >
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
          <div className="col-span-1 md:col-span-2">
            <div className="flex items-center gap-3 mb-4">
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center"
                style={{ background: THEME.accent }}
              >
                <span className="text-xl font-bold text-white">9</span>
              </div>
              <h3 className="text-xl font-bold" style={{ color: THEME.text }}>9Remote</h3>
            </div>
            <p className="text-sm max-w-md mb-4" style={{ color: THEME.textDim }}>
              Secure remote terminal and desktop access. Connect to your machines from anywhere in the world.
            </p>
            <p className="text-xs" style={{ color: THEME.textMuted }}>
              © {new Date().getFullYear()} 9Remote. All rights reserved.
              {version && <span className="ml-2">v{version}</span>}
            </p>
          </div>

          <div>
            <h4 className="font-semibold mb-4 text-sm" style={{ color: THEME.text }}>Product</h4>
            <ul className="space-y-2">
              {PRODUCT_LINKS.map((l) => (
                <li key={l.label}><FooterLink {...l} /></li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="font-semibold mb-4 text-sm" style={{ color: THEME.text }}>Resources</h4>
            <ul className="space-y-2">
              {RESOURCE_LINKS.map((l) => (
                <li key={l.label}><FooterLink {...l} /></li>
              ))}
            </ul>
          </div>
        </div>

        <div
          className="pt-8 flex flex-col sm:flex-row justify-between items-center gap-4 border-t"
          style={{ borderColor: THEME.border }}
        >
          <p className="text-xs" style={{ color: THEME.textMuted }}>
            Built with Next.js, Socket.io, and Cloudflare Workers
          </p>
          <div className="flex gap-6">
            {RESOURCE_LINKS.slice(0, 3).map((l) => (
              <a
                key={l.label}
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs transition-colors"
                style={{ color: THEME.textMuted }}
                onMouseEnter={(e) => (e.currentTarget.style.color = THEME.accent)}
                onMouseLeave={(e) => (e.currentTarget.style.color = THEME.textMuted)}
              >
                {l.label}
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
