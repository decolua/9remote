"use client";

import { useState, useEffect, Suspense, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useAuth } from "@/shared/hooks/useAuth";
import { useApiKeyStorage } from "@/shared/hooks/useApiKeyStorage";
import { maskApiKey } from "@/shared/utils/formatters";
import Container from "@/shared/components/ui/Container";
import Button from "@/shared/components/ui/Button";
import Spinner from "@/shared/components/ui/Spinner";
import QRScanner from "@/shared/components/ui/QRScanner";
import AnimatedBackground from "@/features/landing/components/AnimatedBackground";
import LanguageSwitcher from "@/shared/components/ui/LanguageSwitcher";
import ThemeToggle from "@/shared/theme/ThemeToggle";
import { useI18n } from "@/shared/i18n";
import { X, Eye, EyeOff, LogIn, Trash2, Terminal, QrCode, Home, FileText, Github } from "@/shared/components/ui/Icon";
import { HOMEPAGE_URL, DOCS_URL } from "@/shared/constants/API";
import GithubLoginForm from "@/features/codespace/components/GithubLoginForm";
import CodespaceList from "@/features/codespace/components/CodespaceList";
import { useGithub } from "@/features/codespace/hooks/useGithub";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { buildCodespaceUrl } from "@/shared/constants/github";

function LoginContent() {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState("");
  const [rememberKey, setRememberKey] = useState(true);
  const [savedKeys, setSavedKeys] = useState([]);
  const [isHydrated, setIsHydrated] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showQRScanner, setShowQRScanner] = useState(false);
  const [authTab, setAuthTab] = useState("local");
  const version = process.env.NEXT_PUBLIC_SERVER_VERSION;

  const { token: githubToken, clearToken: clearGithubToken } = useGithub();
  const { setAuth } = useSessionStorage();

  const searchParams = useSearchParams();
  const router = useRouter();
  const { loading, error, authenticateWithToken, authenticateWithApiKey } = useAuth();
  const { loadKeys, saveKey, removeKey, hasStoredKeys, updateLastLogin } = useApiKeyStorage();

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
    if (githubToken) {
      setAuthTab("github");
    }
  }, [loadKeys, githubToken]);

  const handleGithubAuthenticated = () => {};

  const handleGithubLogout = () => {
    clearGithubToken();
  };

  // Connect to a started codespace using the agent apiKey (set via Codespace secret)
  const handleCodespaceConnect = (cs, apiKey) => {
    const tunnelUrl = buildCodespaceUrl(cs.name);
    setAuth({
      apiKey,
      tunnelUrl,
      mode: "remote"
    });
    router.push("/workspace/");
  };

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
      router.push("/workspace/");
    }
  };

  // Check if input is one-time key (6 chars alphanumeric, case-insensitive)
  const isOneTimeKey = (key) => {
    return key.length === 6 && /^[A-Z0-9]+$/i.test(key);
  };

  // Handle API key submit (supports both API key and one-time key)
  const handleConnect = async () => {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) return;

    // Detect one-time key vs API key (one-time key is case-insensitive, uppercase it)
    if (isOneTimeKey(trimmedKey)) {
      const result = await authenticateWithToken(trimmedKey.toUpperCase(), true);
      if (result.success) {
        if (rememberKey && result.apiKey) {
          saveKey(result.apiKey);
        }
        router.push("/workspace/");
      }
    } else {
      const result = await authenticateWithApiKey(apiKey);
      if (result.success) {
        if (rememberKey) {
          saveKey(result.apiKey || apiKey);
        }
        router.push("/workspace/");
      }
    }
  };

  // Handle login with saved key
  const handleLoginWithSavedKey = async (key) => {
    if (!key) return;
    const result = await authenticateWithApiKey(key);
    if (result.success) {
      updateLastLogin(key);
      router.push("/workspace/");
    }
  };

  // Handle remove a saved key
  const handleRemoveKey = (id) => {
    removeKey(id);
    setSavedKeys(loadKeys());
  };

  // Handle QR scan result
  const handleQRScan = async (tempKey) => {
    console.log("handleQRScan called with tempKey:", tempKey);
    
    const result = await authenticateWithToken(tempKey, true);
    
    console.log("Authentication result:", result);
    
    if (result.success) {
      console.log("Authentication successful, redirecting to /workspace/");
      if (rememberKey && result.apiKey) {
        saveKey(result.apiKey);
      }
      router.push("/workspace/");
    } else {
      console.error("Authentication failed:", result.error);
    }
  };

  // Clear input
  const handleClearInput = () => {
    setApiKey("");
  };

  // Format date for display
  const formatLoginDate = (dateString) => {
    if (!dateString) return "";
    try {
      const date = new Date(dateString);
      const now = new Date();
      const diffMs = now - date;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return t("login.justNow");
      if (diffMins < 60) return t("login.minutesAgo", { n: diffMins });
      if (diffHours < 24) return t("login.hoursAgo", { n: diffHours });
      if (diffDays < 7) return t("login.daysAgo", { n: diffDays });
      
      // Format as date if older than a week
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
      return "";
    }
  };

  // Token auth loading screen
  if (isTokenAuth && loading) {
    return (
      <>
        <AnimatedBackground />
        <Container>
          <div className="card-elev p-8 max-w-md w-full border border-border">
            <Spinner size="lg" text={t("login.authenticating")} />
          </div>
        </Container>
      </>
    );
  }

  // Render GitHub flow (codespace list)
  if (authTab === "github" && githubToken) {
    return (
      <>
        <AnimatedBackground />
        <Container>
          <CodespaceList onConnect={handleCodespaceConnect} onLogout={handleGithubLogout} />
        </Container>
      </>
    );
  }

  return (
    <>
      <AnimatedBackground />
      <Container>
        <div className="card-elev p-8 max-w-md w-full border border-border">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-brand-500/10 rounded-brand">
              <Terminal className="text-brand-500" size={32} />
            </div>
            <div className="flex-1">
              <h1 className="text-4xl font-bold text-text">9Remote</h1>
              {version && <p className="text-xs text-text-muted mt-0.5">v{version}</p>}
            </div>
            <LanguageSwitcher />
            <ThemeToggle />
          </div>

          <p className="text-text-muted mb-6">
            {t("login.tagline")}
          </p>

          {/* Auth tabs */}
          <div className="flex gap-1 p-1 mb-6 bg-surface-2 rounded-brand">
            <button
              onClick={() => setAuthTab("local")}
              className={`flex-1 py-2 px-3 rounded-brand text-sm font-medium transition-colors ${
                authTab === "local" ? "bg-surface text-text shadow-sm" : "text-text-muted hover:text-text"
              }`}
            >
              <span className="inline-flex items-center gap-1.5"><Terminal size={14} />Local</span>
            </button>
            <button
              onClick={() => setAuthTab("github")}
              className={`flex-1 py-2 px-3 rounded-brand text-sm font-medium transition-colors ${
                authTab === "github" ? "bg-surface text-text shadow-sm" : "text-text-muted hover:text-text"
              }`}
            >
              <span className="inline-flex items-center gap-1.5"><Github size={14} />Codespace</span>
            </button>
          </div>

          {authTab === "github" && (
            <GithubLoginForm onAuthenticated={handleGithubAuthenticated} />
          )}

          {authTab === "local" && (<>

          {/* QR Scan Section - Temporarily hidden */}
          {false && (
            <>
              <div className="flex flex-col items-center mb-3">
                <button
                  onClick={() => setShowQRScanner(true)}
                  className="flex flex-col items-center gap-2 p-2 bg-surface-2 hover:bg-surface-3 rounded-brand transition-all duration-150 ease-out active:scale-[0.98]"
                  aria-label="Scan QR Code"
                >
                  <QrCode size={48} strokeWidth={1.5} className="text-brand-500" />
                  <span className="text-sm text-text-muted">{t("login.tapToScan")}</span>
                </button>
              </div>

              {/* Divider */}
              <div className="relative mb-3">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full h-px bg-border-subtle"></div>
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="px-4 bg-surface text-text-muted">{t("login.orEnterManually")}</span>
                </div>
              </div>
            </>
          )}

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-text mb-2">
                {t("login.accessKey")}
              </label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && apiKey && handleConnect()}
                  placeholder={t("login.placeholder")}
                  className="w-full px-4 py-3 pr-20 bg-surface-2 rounded-brand text-text placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/40 transition-all duration-150 ease-out"
                />
                {apiKey && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setShowPassword(!showPassword)}
                      className="text-text-muted hover:text-text transition-colors"
                      type="button"
                    >
                      {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                    </button>
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={handleClearInput}
                      className="text-text-muted hover:text-text transition-colors"
                      type="button"
                    >
                      <X size={20} />
                    </button>
                  </div>
                )}
              </div>
              {error && (
                <p className="mt-2 text-sm text-danger">{error}</p>
              )}
            </div>

            <label className="flex items-center gap-2 cursor-pointer group">
              <input
                type="checkbox"
                checked={rememberKey}
                onChange={(e) => handleRememberChange(e.target.checked)}
                className="w-4 h-4 rounded accent-brand-500 focus:ring-2 focus:ring-brand-500/40"
              />
              <span className="text-sm text-text group-hover:text-text transition-colors">{t("login.rememberKey")}</span>
            </label>

            <Button
              variant="primary"
              onClick={handleConnect}
              disabled={!apiKey}
              loading={loading}
              className="w-full"
            >
              {t("login.connect")}
            </Button>
          </div>

          {/* Saved Keys - only render after hydration */}
          {isHydrated && savedKeys.length > 0 && (
            <div className="mt-6 pt-6 border-t border-border-subtle">
              <h3 className="text-sm font-medium text-text mb-3">{t("login.savedKeys")}</h3>
              <div className="space-y-2">
                {savedKeys.map((item) => (
                  <div key={item.id} className="bg-surface-2 rounded-brand p-3 hover:bg-surface-3 transition-all duration-150 ease-out">
                    <div className="flex items-center justify-between gap-3">
                      <div 
                        className="flex-1 min-w-0 cursor-pointer group"
                        onClick={() => handleLoginWithSavedKey(item.key)}
                      >
                        <code className="text-sm text-text group-hover:text-brand-500 font-mono block truncate transition-colors">
                          {maskApiKey(item.key)}
                        </code>
                        {item.lastLoginDate && (
                          <span className="text-xs text-text-muted mt-1 block">
                            {t("login.lastLogin")}: {formatLoginDate(item.lastLoginDate)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleLoginWithSavedKey(item.key)}
                          disabled={loading}
                          className="flex items-center gap-1.5 text-brand-500 hover:text-brand-400 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <LogIn size={16} />
                          {t("login.login")}
                        </button>
                        <button
                          onClick={() => handleRemoveKey(item.id)}
                          disabled={loading}
                          className="flex items-center gap-1 text-text-muted hover:text-danger text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
          </>)}

          <div className="mt-6 pt-6 border-t border-border-subtle flex items-center justify-center gap-4 text-sm text-text-muted">
            <a
              href={HOMEPAGE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 hover:text-brand-500 transition-colors"
            >
              <Home size={14} />
              {t("login.home")}
            </a>
            <span className="text-text-subtle">·</span>
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 hover:text-brand-500 transition-colors"
            >
              <FileText size={14} />
              {t("login.docs")}
            </a>
          </div>
        </div>
      </Container>

      {/* QR Scanner Modal */}
      <QRScanner
        isOpen={showQRScanner}
        onClose={() => setShowQRScanner(false)}
        onScan={handleQRScan}
      />
    </>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <>
        <AnimatedBackground />
        <Container>
          <Spinner text="Loading..." />
        </Container>
      </>
    }>
      <LoginContent />
    </Suspense>
  );
}
