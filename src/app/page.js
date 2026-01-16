"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

const WORKER_API = "https://9remote-worker.decoluadt.workers.dev";

function HomeContent() {
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [isTokenAuth, setIsTokenAuth] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();

  // Check for token in URL (QR code auth)
  useEffect(() => {
    const token = searchParams.get("t");
    if (token) {
      setIsTokenAuth(true);
      handleTokenAuth(token);
    }
  }, [searchParams]);

  // Token-based auth (from QR code)
  async function handleTokenAuth(token) {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(`${WORKER_API}/api/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Invalid or expired token");
      }

      const data = await response.json();

      sessionStorage.setItem("apiKey", data.apiKey);
      sessionStorage.setItem("tunnelUrl", data.tunnelUrl);
      sessionStorage.setItem("mode", "remote");

      router.push("/terminal/");

    } catch (err) {
      setError(err.message);
      setIsTokenAuth(false);
    } finally {
      setLoading(false);
    }
  }

  // Manual API key auth
  async function handleConnect() {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(`${WORKER_API}/api/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Invalid or expired key");
      }

      const data = await response.json();

      sessionStorage.setItem("apiKey", apiKey);
      sessionStorage.setItem("tunnelUrl", data.tunnelUrl);
      sessionStorage.setItem("mode", "remote");

      router.push("/terminal/");

    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Token auth loading screen
  if (isTokenAuth && loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900 flex items-center justify-center p-4">
        <div className="bg-slate-800 p-8 rounded-xl shadow-2xl max-w-md w-full border border-slate-700 text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-slate-400">Authenticating with token...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900 flex items-center justify-center p-4">
      <div className="bg-slate-800 p-8 rounded-xl shadow-2xl max-w-md w-full border border-slate-700">
        <h1 className="text-4xl font-bold text-white mb-2">
          9Remote Terminal
        </h1>

        <p className="text-slate-400 mb-8">
          Access your terminal from anywhere
        </p>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Access Key
            </label>
            <input
              type="text"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && apiKey && handleConnect()}
              placeholder="sk-xxxxxxxxxxxxxxxx-xxxxxx-xxxxxxxx"
              className="w-full px-4 py-3 bg-slate-900 border border-slate-600 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
            />
          </div>

          {error && (
            <div className="text-red-400 text-sm bg-red-950 border border-red-800 rounded-lg p-3">
              {error}
            </div>
          )}

          <button
            onClick={handleConnect}
            disabled={!apiKey || loading}
            className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition transform hover:scale-[1.02] active:scale-[0.98]"
          >
            {loading ? "Connecting..." : "Connect"}
          </button>
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
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900 flex items-center justify-center">
        <div className="text-slate-400">Loading...</div>
      </div>
    }>
      <HomeContent />
    </Suspense>
  );
}
