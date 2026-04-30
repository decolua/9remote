"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import Spinner from "@/shared/components/ui/Spinner";
import Container from "@/shared/components/ui/Container";
import ThemeToggle from "@/shared/theme/ThemeToggle";
import { LayoutDashboard, Users, Shield, LogOut, Menu, X } from "@/shared/components/ui/Icon";
import { useAdminAuth } from "../hooks/useAdminAuth";

const NAV_ITEMS = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/admin/modes", label: "Modes", icon: Shield },
  { href: "/admin/admins", label: "Admins", icon: Users }
];

export default function AdminShell({ children }) {
  const pathname = usePathname();
  const { me, loading, logout } = useAdminAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);

  if (loading || !me) {
    return (
      <Container>
        <Spinner size="lg" text="Loading..." />
      </Container>
    );
  }

  const sidebar = (
    <>
      <div className="p-5 border-b border-border-subtle flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center font-bold text-lg bg-brand-500 text-white shadow-[0_8px_24px_-8px_rgba(255,87,10,0.45)]">
            9
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-bold truncate">9Remote Admin</h1>
            <p className="text-xs text-text-muted mt-0.5 truncate">{me.username} · {me.modeName}</p>
          </div>
        </div>
        <button
          onClick={() => setDrawerOpen(false)}
          className="md:hidden text-text-muted hover:text-text shrink-0"
          aria-label="Close menu"
        >
          <X size={20} />
        </button>
      </div>
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setDrawerOpen(false)}
              className={`flex items-center gap-3 px-3 py-2 rounded-brand text-sm transition-colors ${
                active ? "bg-brand-500/10 text-brand-500" : "text-text-muted hover:bg-surface-2 hover:text-text"
              }`}
            >
              <Icon size={18} />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="m-3 flex items-center gap-2">
        <ThemeToggle className="border border-border-subtle" />
        <button
          onClick={logout}
          className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-brand text-sm text-text-muted hover:bg-surface-2 hover:text-danger transition-colors"
        >
          <LogOut size={18} />
          Logout
        </button>
      </div>
    </>
  );

  return (
    <div className="min-h-screen bg-bg text-text">
      {/* Mobile top bar */}
      <header className="md:hidden sticky top-0 z-30 flex items-center justify-between px-4 py-3 bg-surface border-b border-border-subtle">
        <button
          onClick={() => setDrawerOpen(true)}
          className="text-text-muted hover:text-text"
          aria-label="Open menu"
        >
          <Menu size={22} />
        </button>
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-base bg-brand-500 text-white">9</div>
          <h1 className="text-base font-semibold">9Remote Admin</h1>
        </div>
        <ThemeToggle />
      </header>

      {/* Desktop sidebar */}
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-60 border-r border-border-subtle bg-surface flex-col">
        {sidebar}
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <>
          <div className="md:hidden fixed inset-0 z-40 bg-black/50 fade-in" onClick={() => setDrawerOpen(false)} />
          <aside className="md:hidden fixed inset-y-0 left-0 z-50 w-72 max-w-[80%] bg-surface border-r border-border-subtle flex flex-col slide-in-right" style={{ animation: "slideInFromLeft 0.25s cubic-bezier(0.22, 1, 0.36, 1) forwards" }}>
            {sidebar}
          </aside>
        </>
      )}

      <main className="md:ml-60 p-4 md:p-6">{children}</main>

      <style jsx global>{`
        @keyframes slideInFromLeft {
          from { transform: translateX(-100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
