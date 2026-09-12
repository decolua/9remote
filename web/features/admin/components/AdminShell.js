"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import Spinner from "@/shared/components/ui/Spinner";
import Container from "@/shared/components/ui/Container";
import ThemeToggle from "@/shared/theme/ThemeToggle";
import AnimatedBackground from "@/features/landing/components/AnimatedBackground";
import { LayoutDashboard, Users, Shield, LogOut, Menu, X, Package, Terminal, KeyRound } from "@/shared/components/ui/Icon";
import { useAdminAuth } from "../hooks/useAdminAuth";

const NAV_ITEMS = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/admin/modes", label: "Modes", icon: Shield },
  { href: "/admin/admins", label: "Admins", icon: Users },
  { href: "/admin/ota", label: "OTA Updates", icon: Package },
  { href: "/admin/turn", label: "TURN Keys", icon: KeyRound }
];

export default function AdminShell({ children }) {
  const pathname = usePathname();
  const { me, loading, logout } = useAdminAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);

  if (loading || !me) {
    return (
      <>
        <AnimatedBackground />
        <Container>
          <div className="card-glass p-8 max-w-sm w-full flex flex-col items-center justify-center">
            <Spinner size="lg" text="Loading admin..." />
          </div>
        </Container>
      </>
    );
  }

  const sidebarContent = (
    <>
      <div className="p-5 border-b border-border-subtle flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 shrink-0 rounded-xl flex items-center justify-center font-bold text-lg bg-brand-500 text-white shadow-[0_8px_24px_-8px_rgba(255,87,10,0.6)] ring-1 ring-white/20">
            9
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-bold tracking-tight text-text truncate">9Remote Admin</h1>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-xs text-text-muted truncate">{me.username}</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-brand-500/10 text-brand-500 border border-brand-500/20">
                {me.modeName || me.modeId}
              </span>
            </div>
          </div>
        </div>
        <button
          onClick={() => setDrawerOpen(false)}
          className="md:hidden text-text-muted hover:text-text shrink-0 p-1.5 rounded-lg hover:bg-surface-2 transition-colors"
          aria-label="Close menu"
        >
          <X size={18} />
        </button>
      </div>

      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        <div className="px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider text-text-subtle">
          Navigation
        </div>
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setDrawerOpen(false)}
              className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all ${
                active
                  ? "bg-brand-500/12 text-brand-500 border border-brand-500/25 shadow-[0_2px_12px_-4px_rgba(255,87,10,0.25)]"
                  : "text-text-muted hover:bg-surface-2/80 hover:text-text border border-transparent"
              }`}
            >
              <Icon size={18} className={active ? "text-brand-500" : "text-text-subtle"} />
              <span className="flex-1">{item.label}</span>
              {active && <span className="w-1.5 h-1.5 rounded-full bg-brand-500" />}
            </Link>
          );
        })}
      </nav>

      <div className="p-3 border-t border-border-subtle space-y-2">
        <Link
          href="/workspace/"
          className="flex items-center gap-2.5 px-3.5 py-2 rounded-xl text-xs text-text-muted hover:bg-surface-2 hover:text-text transition-colors border border-border-subtle/50"
        >
          <Terminal size={15} className="text-brand-500" />
          <span>Open Workspace</span>
        </Link>
        <div className="flex items-center gap-2 pt-1">
          <ThemeToggle className="border border-border-subtle hover:bg-surface-2 rounded-xl" />
          <button
            onClick={logout}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-medium text-text-muted hover:bg-red-500/10 hover:text-danger hover:border-red-500/20 border border-transparent transition-all"
          >
            <LogOut size={15} />
            Logout
          </button>
        </div>
      </div>
    </>
  );

  return (
    <div className="min-h-screen text-text relative selection:bg-brand-500/20">
      <AnimatedBackground />

      {/* Mobile top bar */}
      <header className="md:hidden sticky top-0 z-30 flex items-center justify-between px-4 py-3 bg-surface/80 backdrop-blur-md border-b border-border-subtle">
        <button
          onClick={() => setDrawerOpen(true)}
          className="p-1.5 -ml-1.5 text-text-muted hover:text-text rounded-lg hover:bg-surface-2"
          aria-label="Open menu"
        >
          <Menu size={20} />
        </button>
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-sm bg-brand-500 text-white shadow-sm">9</div>
          <h1 className="text-sm font-semibold tracking-tight">9Remote Admin</h1>
        </div>
        <ThemeToggle className="rounded-lg" />
      </header>

      {/* Desktop sidebar */}
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-64 border-r border-border-subtle bg-surface/80 backdrop-blur-xl flex-col z-20 shadow-[4px_0_24px_-12px_rgba(0,0,0,0.2)]">
        {sidebarContent}
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <>
          <div className="md:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm fade-in" onClick={() => setDrawerOpen(false)} />
          <aside className="md:hidden fixed inset-y-0 left-0 z-50 w-72 max-w-[85%] bg-surface/95 backdrop-blur-2xl border-r border-border-subtle flex flex-col slide-in-right" style={{ animation: "slideInFromLeft 0.22s cubic-bezier(0.22, 1, 0.36, 1) forwards" }}>
            {sidebarContent}
          </aside>
        </>
      )}

      {/* Main content */}
      <main className="md:ml-64 p-4 sm:p-6 lg:p-8 min-h-screen relative z-10 max-w-7xl">
        {children}
      </main>

      <style jsx global>{`
        @keyframes slideInFromLeft {
          from { transform: translateX(-100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
