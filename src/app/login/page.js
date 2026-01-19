"use client";

import { useState, useEffect, Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/shared/hooks/useAuth";
import Container from "@/shared/components/ui/Container";
import Input from "@/shared/components/ui/Input";
import Button from "@/shared/components/ui/Button";
import Spinner from "@/shared/components/ui/Spinner";

function LoginContent() {
  const [apiKey, setApiKey] = useState("");
  const searchParams = useSearchParams();
  const { loading, error, authenticateWithToken, authenticateWithApiKey } = useAuth();

  // Check for token in URL (QR code auth)
  const token = useMemo(() => searchParams.get("t"), [searchParams]);
  const isTokenAuth = !!token;

  useEffect(() => {
    if (token) {
      authenticateWithToken(token);
    }
  }, [token, authenticateWithToken]);

  // Handle API key submit
  const handleConnect = () => {
    if (!apiKey.trim()) return;
    authenticateWithApiKey(apiKey);
  };

  // Token auth loading screen
  if (isTokenAuth && loading) {
    return (
      <Container>
        <div className="bg-slate-800 p-8 rounded-xl shadow-2xl max-w-md w-full border border-slate-700">
          <Spinner size="lg" text="Authenticating with token..." />
        </div>
      </Container>
    );
  }

  return (
    <Container>
      <div className="bg-slate-800 p-8 rounded-xl shadow-2xl max-w-md w-full border border-slate-700">
        <h1 className="text-4xl font-bold text-white mb-2">
          9Remote Terminal
        </h1>

        <p className="text-slate-400 mb-8">
          Access your terminal from anywhere
        </p>

        <div className="space-y-4">
          <Input
            label="Access Key"
            type="text"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && apiKey && handleConnect()}
            placeholder="sk-xxxxxxxxxxxxxxxx-xxxxxx-xxxxxxxx"
            error={error}
          />

          <Button
            variant="primary"
            onClick={handleConnect}
            disabled={!apiKey}
            loading={loading}
            className="w-full"
          >
            Connect
          </Button>
        </div>

        <div className="mt-8 pt-6 border-t border-slate-700">
          <p className="text-sm text-slate-400">
            Need a terminal? Run{" "}
            <code className="text-blue-400 bg-slate-900 px-2 py-1 rounded">
              9remote start
            </code>
          </p>
        </div>
      </div>
    </Container>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <Container>
        <Spinner text="Loading..." />
      </Container>
    }>
      <LoginContent />
    </Suspense>
  );
}
