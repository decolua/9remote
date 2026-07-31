"use client";

import { useState, useEffect, Suspense, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useAuth } from "@/shared/hooks/useAuth";
import { useApiKeyStorage } from "@/shared/hooks/useApiKeyStorage";
import { maskApiKey } from "@/shared/utils/formatters";
import Container from "@/shared/components/ui/Container";
import Icon from "@/shared/components/ui/Icon";
import QRScanner from "@/shared/components/ui/QRScanner";
import Button from "@/shared/components/ui/Button";
import Spinner from "@/shared/components/ui/Spinner";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import AnimatedBackground from "@/features/landing/components/AnimatedBackground";
import LanguageSwitcher from "@/shared/components/ui/LanguageSwitcher";
import ThemeToggle from "@/shared/theme/ThemeToggle";
import { useI18n } from "@/shared/i18n";
import { X, Eye, EyeOff, LogIn, Trash2, Terminal, Home, FileText, Pencil, Check } from "@/shared/components/ui/Icon";
import { HOMEPAGE_URL, DOCS_URL } from "@/shared/constants/API";
import GithubLoginForm from "@/features/codespace/components/GithubLoginForm";
import CodespaceList from "@/features/codespace/components/CodespaceList";
import { useGithub } from "@/features/codespace/hooks/useGithub";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { buildCodespaceUrl } from "@/shared/constants/github";
import AgentSwitcher from "@/features/terminal/components/AgentSwitcher";

// Terminal-glyph laptop + phone hero illustration (brand-tinted, theme-agnostic)
function LoginContent() {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState("");
  const [rememberKey, setRememberKey] = useState(true);
  const [savedKeys, setSavedKeys] = useState([]);
  const [isHydrated, setIsHydrated] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showQRScanner, setShowQRScanner] = useState(false);
  const [authTab, setAuthTab] = useState("local");
  const [editingKeyId, setEditingKeyId] = useState(null);
  const [editingLabel, setEditingLabel] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [loginLoadingKey, setLoginLoadingKey] = useState(null);
  const version = process.env.NEXT_PUBLIC_SERVER_VERSION;

  const { token: githubToken, clearToken: clearGithubToken } = useGithub();
  const { setAuth } = useSessionStorage();

  const searchParams = useSearchParams();
  const router = useRouter();
  const { loading, error, authenticateWithToken, authenticateWithApiKey } = useAuth();
  const { loadKeys, saveKey, removeKey, renameKey, hasStoredKeys, updateLastLogin } = useApiKeyStorage();

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
    setLoginLoadingKey(key);
    let result;
    try {
      result = await authenticateWithApiKey(key);
    } finally {
      setLoginLoadingKey(null);
    }
    if (result?.success) {
      updateLastLogin(key);
      // From login always land on workspace home — last-route restore is for in-app switching
      router.push("/workspace/");
    }
  };

  // Confirm and remove the targeted key
  const handleConfirmRemoveKey = () => {
    if (!deleteTarget) return;
    removeKey(deleteTarget.id);
    setSavedKeys(loadKeys());
  };

  // Start editing a key's label
  const handleStartRename = (item) => {
    setEditingKeyId(item.id);
    setEditingLabel(item.label || "");
  };

  // Save edited label
  const handleSaveRename = (id) => {
    renameKey(id, editingLabel.trim());
    setSavedKeys(loadKeys());
    setEditingKeyId(null);
  };

  // Cancel editing
  const handleCancelRename = () => {
    setEditingKeyId(null);
  };

  // Handle QR scan result
  const handleQRScan = async (tempKey) => {
    const result = await authenticateWithToken(tempKey, true);
    if (result.success) {
      if (rememberKey && result.apiKey) {
        saveKey(result.apiKey);
      }
      router.push("/workspace/");
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
      <Container centered={true} className="py-8 bg-gradient-to-b from-brand-500/10 via-brand-500/[0.03] to-transparent">
        <div className="max-w-md w-full mx-auto space-y-4">

          {/* Header */}
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-brand-500 rounded-2xl shadow-lg shadow-brand-500/30">
              <Terminal className="text-white" size={28} />
            </div>
            <div className="flex-1">
              <h1 className="text-3xl font-extrabold text-text leading-none">9Remote</h1>
              {version && <p className="text-xs font-semibold text-brand-500 mt-1">v{version}</p>}
            </div>
            <LanguageSwitcher />
            <ThemeToggle />
          </div>

          {/* Hero */}
          <p className="text-text-muted text-lg font-medium leading-snug pr-16 mb-10">
            {t("login.tagline")}
          </p>

          {authTab === "github" && (
            <div className="card-elev rounded-2xl p-5 border border-border">
              <GithubLoginForm onAuthenticated={handleGithubAuthenticated} />
            </div>
          )}

          {authTab === "local" && (<>

          {/* Access Key card */}
          <div className="card-elev rounded-2xl p-5 border border-border relative">
            <div className="flex items-center gap-2 mb-4">
              <div className="p-1.5 bg-brand-500/10 rounded-xl">
                <Icon name="KeyRound" className="text-brand-500" size={20} />
              </div>
              <h2 className="text-lg font-bold text-text">{t("login.accessKey")}</h2>
            </div>

            <div className="relative">
              <input
                id="accessKeyInput"
                type={showPassword ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && apiKey && handleConnect()}
                placeholder={t("login.placeholder")}
                className="w-full px-4 py-3.5 pr-14 bg-surface-2 rounded-xl text-text placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/40 transition-all duration-150 ease-out"
              />
              <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
                {apiKey && (
                  <>
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
                  </>
                )}
              </div>
            </div>
            {error && <p className="mt-2 text-sm text-danger">{error}</p>}

            <label className="flex items-center gap-2 cursor-pointer group mt-4">
              <input
                type="checkbox"
                checked={rememberKey}
                onChange={(e) => handleRememberChange(e.target.checked)}
                className="w-4 h-4 rounded accent-brand-500 focus:ring-2 focus:ring-brand-500/40"
              />
              <span className="text-sm text-text">{t("login.rememberKey")}</span>
            </label>

            <Button
              variant="primary"
              onClick={handleConnect}
              loading={loading}
              className="w-full mt-4"
            >
              <span className="inline-flex items-center justify-center gap-2">
                {t("login.connect")}
                <Icon name="ArrowRight" size={18} />
              </span>
            </Button>

          {/* Saved agents — inside the auth card, below the connect button */}
          {isHydrated && savedKeys.length > 0 && (
            <div className="mt-5 pt-5 border-t border-border-subtle">
              <AgentSwitcher
                variant="login"
                keys={savedKeys}
                onSelect={handleLoginWithSavedKey}
                loadingKey={loginLoadingKey}
              />
            </div>
          )}
          </div>
          </>)}

          {/* Footer nav */}
          <div className="flex items-center justify-center gap-4 pt-1 text-sm">
            <a
              href={HOMEPAGE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-brand-500 font-semibold transition-colors"
            >
              <Home size={16} />
              {t("login.home")}
            </a>
            <span className="text-text-subtle">·</span>
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-text-muted hover:text-brand-500 font-medium transition-colors"
            >
              <FileText size={16} />
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

      {/* Delete key confirmation */}
      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleConfirmRemoveKey}
        title={t("login.deleteKeyTitle")}
        message={t("login.deleteKeyConfirm", { name: deleteTarget?.label })}
        confirmText={t("common.delete")}
      />
    </>
  );
}

// Pre-hydration fallback. The reload escape hatch is a plain <a> so it still works
// when the page JS never arrives (dead network) — a React onClick would not.
function LoginFallback() {
  return (
    <>
      <AnimatedBackground />
      <Container>
        <div className="flex flex-col items-center gap-4">
          <Spinner text="Loading..." />
          <a
            href="/login"
            className="text-sm text-text-muted hover:text-brand-500 underline underline-offset-4 transition-colors"
          >
            Reload
          </a>
        </div>
      </Container>
    </>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginContent />
    </Suspense>
  );
}
