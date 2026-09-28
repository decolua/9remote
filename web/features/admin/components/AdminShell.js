"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import Spinner from "@/shared/components/ui/Spinner";
import Container from "@/shared/components/ui/Container";
import ThemeToggle from "@/shared/theme/ThemeToggle";
import AnimatedBackground from "@/features/landing/components/AnimatedBackground";
import { LayoutDashboard, Users, LogOut, Menu, X, Package, KeyRound } from "@/shared/components/ui/Icon";
import { useAdminAuth } from "../hooks/useAdminAuth";

const NAV_ITEMS = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/admin/access", label: "Access", icon: Users },
  { href: "/admin/ota", label: "OTA Updates", icon: Package, needsOta: true },
  { href: "/admin/turn", label: "TURN Keys", icon: KeyRound }
];

// Workspace-sidebar item look: flat rounded-[6px], quiet hover, active = surface-3.
const itemClass = (active) => `
  flex items-center gap-2.5 -ml-3.5 w-[calc(100%+0.875rem)] pl-[17px] pr-3 py-1.5
  rounded-[6px] text-xs font-medium text-left transition-colors duration-150
  ${active ? "bg-surface-3 text-text font-semibold" : "text-text-muted hover:bg-surface-2 hover:text-text"}
`;

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
      <div className="p-4 border-b border-border-subtle flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-6 h-6 shrink-0 rounded-md flex items-center justify-center font-bold text-sm bg-brand-500 text-white">
            9
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-bold tracking-tight text-text truncate">9Remote Admin</h1>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-xs text-text-muted truncate">{me.username}</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-surface-2 text-text-muted border border-border-subtle">
                {me.modeName || me.modeId}
              </span>
            </div>
          </div>
        </div>
        <button
          onClick={() => setDrawerOpen(false)}
          className="md:hidden p-1.5 -mr-1.5 text-text-muted hover:text-text rounded-[6px] hover:bg-surface-2 transition-colors"
          aria-label="Close menu"
        >
          <X size={18} />
        </button>
      </div>

      <nav className="flex-1 px-3.5 py-3 space-y-0.5 overflow-y-auto">
        <div className="pl-[3.5px] py-1.5 text-[10px] font-mono uppercase tracking-wider text-text-subtle">
          Navigation
        </div>
        {NAV_ITEMS.filter((item) => !item.needsOta || me.otaEnabled).map((item) => {
          const Icon = item.icon;
          const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setDrawerOpen(false)}
              className={itemClass(active)}
            >
              <Icon size={15} className={active ? "text-text" : "text-text-subtle"} />
              <span className="flex-1">{item.label}</span>
              {active && <span className="w-1 h-1 rounded-full bg-text-muted" />}
            </Link>
          );
        })}
      </nav>

      <div className="p-3.5 border-t border-border-subtle">
        <div className="flex items-center gap-2">
          <ThemeToggle className="border border-border-subtle hover:bg-surface-2 rounded-[6px]" />
          <button
            onClick={logout}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-1.5 rounded-[6px] text-xs font-medium text-text-muted hover:bg-red-500/10 hover:text-danger transition-colors"
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
      <header className="md:hidden sticky top-0 z-30 flex items-center justify-between px-4 py-2.5 bg-surface/80 backdrop-blur-md border-b border-border-subtle">
        <button
          onClick={() => setDrawerOpen(true)}
          className="p-1.5 -ml-1.5 text-text-muted hover:text-text rounded-[6px] hover:bg-surface-2"
          aria-label="Open menu"
        >
          <Menu size={20} />
        </button>
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md flex items-center justify-center font-bold text-xs bg-brand-500 text-white">9</div>
          <h1 className="text-sm font-semibold tracking-tight">9Remote Admin</h1>
        </div>
        <ThemeToggle className="rounded-[6px]" />
      </header>

      {/* Desktop sidebar */}
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-60 border-r border-border-subtle bg-surface/80 backdrop-blur-xl flex-col z-20">
        {sidebarContent}
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <>
          <div className="md:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px] fade-in" onClick={() => setDrawerOpen(false)} />
          <aside className="md:hidden fixed inset-y-0 left-0 z-50 w-72 max-w-[85%] bg-surface/95 backdrop-blur-2xl border-r border-border-subtle flex flex-col slide-in-right" style={{ animation: "slideInFromLeft 0.22s cubic-bezier(0.22, 1, 0.36, 1) forwards" }}>
            {sidebarContent}
          </aside>
        </>
      )}

      {/* Main content */}
      <main className="md:ml-60 p-4 sm:p-6 lg:p-8 min-h-screen relative z-10 max-w-7xl">
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
