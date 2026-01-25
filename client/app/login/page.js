"use client";

import { useState, useEffect, Suspense, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useAuth } from "@/shared/hooks/useAuth";
import { useApiKeyStorage } from "@/shared/hooks/useApiKeyStorage";
import { maskApiKey } from "@/shared/utils/formatters";
import Container from "@/shared/components/ui/Container";
import Button from "@/shared/components/ui/Button";
import Spinner from "@/shared/components/ui/Spinner";
import { X, Eye, EyeOff, LogIn, Trash2, Terminal } from "@/shared/components/ui/Icon";

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
        <div className="bg-dark-600 p-8 rounded-brand-lg shadow-2xl max-w-md w-full border border-dark-400">
          <Spinner size="lg" text="Authenticating with token..." />
        </div>
      </Container>
    );
  }

  return (
    <>
      <Container>
        <div className="bg-dark-600 p-8 rounded-brand-lg shadow-2xl max-w-md w-full border border-dark-400">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-brand-500/10 rounded-brand">
              <Terminal className="text-brand-500" size={32} />
            </div>
            <h1 className="text-4xl font-bold text-white">
              9Remote
            </h1>
          </div>

          <p className="text-dark-100 mb-8">
            Access your terminal from anywhere
          </p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-dark-50 mb-2">
                Access Key
              </label>
              <div className="relative">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && apiKey && handleConnect()}
                  placeholder="sk-xxx... or One-Time Key (ABC123)"
                  className="w-full px-4 py-3 pr-10 bg-dark-700 border border-dark-400 rounded-brand text-white placeholder-dark-100 focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-transparent transition-all duration-200"
                />
                {apiKey && (
                  <button
                    onClick={handleClearInput}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-dark-100 hover:text-white transition-colors"
                  >
                    <X size={20} />
                  </button>
                )}
              </div>
              {error && (
                <p className="mt-2 text-sm text-red-400">{error}</p>
              )}
            </div>

            <label className="flex items-center gap-2 cursor-pointer group">
              <input
                type="checkbox"
                checked={rememberKey}
                onChange={(e) => handleRememberChange(e.target.checked)}
                className="w-4 h-4 bg-dark-700 border-dark-400 rounded accent-brand-500 focus:ring-1 focus:ring-brand-500"
              />
              <span className="text-sm text-dark-50 group-hover:text-white transition-colors">Remember this key</span>
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
            <div className="mt-6 pt-6 border-t border-dark-400">
              <h3 className="text-sm font-medium text-dark-50 mb-3">Saved Keys</h3>
              <div className="space-y-2">
                {savedKeys.map((item) => (
                  <div key={item.id} className="bg-dark-700/50 border border-dark-400 rounded-brand p-3 hover:border-brand-500/30 transition-colors">
                    <div className="flex items-center justify-between gap-3">
                      <div 
                        className="flex-1 min-w-0 cursor-pointer group"
                        onClick={() => handleLoginWithSavedKey(item.key)}
                      >
                        <code className="text-sm text-dark-50 group-hover:text-brand-500 font-mono block truncate transition-colors">
                          {maskApiKey(item.key)}
                        </code>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleLoginWithSavedKey(item.key)}
                          disabled={loading}
                          className="flex items-center gap-1.5 text-brand-500 hover:text-brand-400 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <LogIn size={16} />
                          Login
                        </button>
                        <button
                          onClick={() => handleRemoveKey(item.id)}
                          disabled={loading}
                          className="flex items-center gap-1 text-dark-100 hover:text-red-400 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Trash2 size={16} />
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
