"use client";

import { useState, useEffect, Suspense, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useAuth } from "@/shared/hooks/useAuth";
import { useApiKeyStorage } from "@/shared/hooks/useApiKeyStorage";
import { maskApiKey } from "@/shared/utils/formatters";
import Container from "@/shared/components/ui/Container";
import Button from "@/shared/components/ui/Button";
import Spinner from "@/shared/components/ui/Spinner";

function LoginContent() {
  const [apiKey, setApiKey] = useState("");
  const [rememberKey, setRememberKey] = useState(true);
  const [savedKeys, setSavedKeys] = useState([]);
  const [isHydrated, setIsHydrated] = useState(false);

  const searchParams = useSearchParams();
  const router = useRouter();
  const { loading, error, authenticateWithToken, authenticateWithApiKey } = useAuth();
  const { loadKeys, saveKey, removeKey, hasStoredKeys } = useApiKeyStorage();

  // Check for token (old) or temp key (new) in URL (QR code auth)
  const token = useMemo(() => searchParams.get("t"), [searchParams]);
  const tempKey = useMemo(() => searchParams.get("k"), [searchParams]);
  const isTokenAuth = !!token || !!tempKey;

  // Load saved data after hydration (client-side only)
  useEffect(() => {
    const savedPreference = localStorage.getItem("9remote_remember_key_preference");
    setRememberKey(savedPreference !== "false");
    setSavedKeys(loadKeys());
    setIsHydrated(true);
  }, [loadKeys]);

  // Handle remember key checkbox change
  const handleRememberChange = (checked) => {
    setRememberKey(checked);
    if (typeof window !== "undefined") {
      localStorage.setItem("9remote_remember_key_preference", checked);
    }
  };

  useEffect(() => {
    if (token) {
      authenticateWithToken(token);
    } else if (tempKey) {
      authenticateWithTempKey(tempKey);
    }
  }, [token, tempKey, authenticateWithToken]);

  // Handle temp key auth
  const authenticateWithTempKey = async (tk) => {
    const result = await authenticateWithToken(tk, true);
    if (result.success) {
      // Auto save API key if "Remember this key" is checked
      if (rememberKey && result.apiKey) {
        saveKey(result.apiKey);
      }
      router.push("/terminal/");
    }
  };

  // Check if input is one-time key (6 chars uppercase alphanumeric)
  const isOneTimeKey = (key) => {
    return key.length === 6 && /^[A-Z0-9]+$/.test(key);
  };

  // Handle API key submit (supports both API key and one-time key)
  const handleConnect = async () => {
    const trimmedKey = apiKey.trim().toUpperCase();
    if (!trimmedKey) return;

    // Detect one-time key vs API key
    if (isOneTimeKey(trimmedKey)) {
      const result = await authenticateWithToken(trimmedKey, true);
      if (result.success) {
        if (rememberKey && result.apiKey) {
          saveKey(result.apiKey);
        }
        router.push("/terminal/");
      }
    } else {
      const result = await authenticateWithApiKey(apiKey);
      if (result.success) {
        if (rememberKey) {
          saveKey(result.apiKey || apiKey);
        }
        router.push("/terminal/");
      }
    }
  };

  // Handle login with saved key
  const handleLoginWithSavedKey = async (key) => {
    if (!key) return;
    const result = await authenticateWithApiKey(key);
    if (result.success) {
      router.push("/terminal/");
    }
  };

  // Handle remove a saved key
  const handleRemoveKey = (id) => {
    removeKey(id);
    setSavedKeys(loadKeys());
  };

  // Clear input
  const handleClearInput = () => {
    setApiKey("");
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
    <>
      <Container>
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
              <div className="relative">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && apiKey && handleConnect()}
                  placeholder="sk-xxx... or One-Time Key (ABC123)"
                  className="w-full px-4 py-3 pr-10 bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                {apiKey && (
                  <button
                    onClick={handleClearInput}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white transition"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
              {error && (
                <p className="mt-2 text-sm text-red-400">{error}</p>
              )}
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={rememberKey}
                onChange={(e) => handleRememberChange(e.target.checked)}
                className="w-4 h-4 bg-slate-900 border-slate-700 rounded text-blue-500 focus:ring-2 focus:ring-blue-500"
              />
              <span className="text-sm text-slate-300">Remember this key</span>
            </label>

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

          {/* Saved Keys - only render after hydration */}
          {isHydrated && savedKeys.length > 0 && (
            <div className="mt-6 pt-6 border-t border-slate-700">
              <h3 className="text-sm font-medium text-slate-300 mb-3">Saved Keys</h3>
              <div className="space-y-2">
                {savedKeys.map((item) => (
                  <div key={item.id} className="bg-slate-900/50 border border-slate-700 rounded-lg p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div 
                        className="flex-1 min-w-0 cursor-pointer group"
                        onClick={() => handleLoginWithSavedKey(item.key)}
                      >
                        <code className="text-sm text-slate-300 group-hover:text-blue-400 font-mono block truncate transition">
                          {maskApiKey(item.key)}
                        </code>
                      </div>
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => handleLoginWithSavedKey(item.key)}
                          disabled={loading}
                          className="flex items-center gap-1.5 text-blue-400 hover:text-blue-300 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                          </svg>
                          Login
                        </button>
                        <button
                          onClick={() => handleRemoveKey(item.id)}
                          disabled={loading}
                          className="flex items-center gap-1.5 text-slate-400 hover:text-red-400 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </Container>

    </>
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
