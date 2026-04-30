"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Container from "@/shared/components/ui/Container";
import Button from "@/shared/components/ui/Button";
import Input from "@/shared/components/ui/Input";
import ThemeToggle from "@/shared/theme/ThemeToggle";
import { ADMIN_API } from "@/features/admin/constants";

export default function AdminLoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!username || !password) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(ADMIN_API.login, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        credentials: "include"
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Login failed");
      router.replace("/admin");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container>
      <div className="card-elev p-8 max-w-md w-full border border-border">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center font-bold text-xl bg-brand-500 text-white shadow-[0_8px_24px_-8px_rgba(255,87,10,0.45)]">
            9
          </div>
          <h1 className="text-3xl font-bold text-text flex-1">9Remote Admin</h1>
          <ThemeToggle />
        </div>
        <p className="text-text-muted mb-8">Sign in to manage 9Remote</p>

        <div className="space-y-4">
          <Input
            label="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="admin username"
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          />
          <Input
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="password"
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            error={error}
          />
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!username || !password}
            loading={loading}
            className="w-full"
          >
            Sign in
          </Button>
        </div>
      </div>
    </Container>
  );
}
