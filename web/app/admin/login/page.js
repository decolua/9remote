"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Container from "@/shared/components/ui/Container";
import Button from "@/shared/components/ui/Button";
import Input from "@/shared/components/ui/Input";
import ThemeToggle from "@/shared/theme/ThemeToggle";
import AnimatedBackground from "@/features/landing/components/AnimatedBackground";
import TurnstileWidget from "@/features/admin/components/TurnstileWidget";
import { Shield, ArrowRight, AlertCircle } from "@/shared/components/ui/Icon";
import { ADMIN_API } from "@/features/admin/constants";

export default function AdminLoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [siteKey, setSiteKey] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");

  useEffect(() => {
    fetch(ADMIN_API.turnstile)
      .then((r) => r.json())
      .then((d) => setSiteKey(d?.siteKey || ""))
      .catch(() => setSiteKey(""));
  }, []);

  const handleSubmit = async () => {
    if (!username || !password) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(ADMIN_API.login, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, turnstileToken }),
        credentials: "include"
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Login failed");
      router.replace("/admin");
    } catch (e) {
      setError(e.message);
      setTurnstileToken("");
      window.turnstile?.reset?.();
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <AnimatedBackground />
      <Container>
        <div className="card-glass p-8 sm:p-10 max-w-md w-full relative overflow-hidden">
          {/* Subtle top brand glow */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-48 h-1 bg-brand-500/80 rounded-full blur-sm" />

          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center font-bold text-lg bg-brand-500 text-white shadow-[0_8px_24px_-6px_rgba(255,87,10,0.5)] ring-1 ring-white/20">
                9
              </div>
              <div>
                <span className="text-[11px] font-mono tracking-wider uppercase text-brand-500 font-semibold block">Console</span>
                <h1 className="text-xl font-bold tracking-tight text-text">9Remote Admin</h1>
              </div>
            </div>
            <ThemeToggle className="rounded-xl border border-border-subtle" />
          </div>

          <div className="mb-6">
            <h2 className="text-2xl font-bold tracking-tight text-text login-hero-grad">Welcome back</h2>
            <p className="text-xs text-text-muted mt-1">Sign in with administrator credentials to manage node instances</p>
          </div>

          {error && (
            <div className="mb-5 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-danger text-xs flex items-center gap-2">
              <AlertCircle size={15} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="space-y-4">
            <Input
              label="Admin Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. root"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            />
            <Input
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            />
            <TurnstileWidget siteKey={siteKey} onToken={setTurnstileToken} />
            <Button
              variant="primary"
              onClick={handleSubmit}
              disabled={!username || !password || (siteKey && !turnstileToken)}
              loading={loading}
              className="w-full py-2.5 rounded-xl shadow-[0_8px_20px_-6px_rgba(255,87,10,0.45)] font-semibold"
            >
              <span className="inline-flex items-center justify-center gap-2">
                <span>Authenticate</span>
                <ArrowRight size={16} />
              </span>
            </Button>
          </div>

          <div className="mt-8 pt-5 border-t border-border-subtle flex items-center justify-between text-xs text-text-subtle">
            <div className="flex items-center gap-1.5">
              <Shield size={13} className="text-brand-500" />
              <span>Restricted access</span>
            </div>
            <Link href="/login" className="hover:text-brand-500 transition-colors">
              User Login &rarr;
            </Link>
          </div>
        </div>
      </Container>
    </>
  );
}
