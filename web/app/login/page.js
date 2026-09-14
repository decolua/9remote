"use client";

import { useState, useEffect, useRef, Suspense, useMemo, useCallback } from "react";
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
import { X } from "@/shared/components/ui/Icon";
import CodespaceList from "@/features/codespace/components/CodespaceList";
import { useGithub } from "@/features/codespace/hooks/useGithub";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { buildCodespaceUrl } from "@/shared/constants/github";
import { setTrust, withTail } from "@/shared/transport/lib/deviceTrust";
import { LOGIN_ERROR_KEY, ONE_TIME_CODE_LENGTH, PENDING_SAVE_KEY, WANTS_SAVE_KEY } from "@/shared/constants/transport";
import { headOf, tailOf } from "@/shared/utils/apiKey";
import { isLoopbackOrigin } from "@/shared/utils/localOrigin";
import { AGENT_PORT } from "@/shared/constants/API";

// One-time pairing input: "K7QP3Max" (6-char tempKey + 2-char TAIL, no
// separator), a bare "K7QP3M", or a full login URL carrying either in
// query/fragment. A hyphenated form is still accepted — older agents emit it,
// and users re-type old codes. The TAIL stays in the browser (device trust);
// only the 6-char tempKey is ever sent anywhere.
/**
 * A one-time code is two parts read as one token: 6 chars the Worker knows
 * (routing) and a 2-char TAIL it never sees (the secret). The TAIL is the same
 * kind of thing an API key carries — the difference is that this one dies with
 * the code, and dies early if it is guessed at.
 *
 * The halves are told apart by POSITION, not by case: six characters of code
 * then two of tail. Case used to carry that meaning, which made a code
 * unreadable the moment either half was typed in the other case — the agent
 * folds case when it compares, so the parser does too.
 */
function parsePairingInput(raw) {
  const str = String(raw || "").trim();
  const split = (code) => ({
    tempKey: code.slice(0, 6).toUpperCase(),
    tail: code.slice(6, 8).toUpperCase()
  });

  const hashMatch = /#([A-NP-Z1-9]{6}-?[a-np-z1-9]{2})$/i.exec(str);
  if (hashMatch) return split(hashMatch[1].replace(/-/g, ""));

  const codeMatch = /^([A-NP-Z1-9]{6}-?[a-np-z1-9]{2})$/i.exec(str);
  if (codeMatch) return split(codeMatch[1].replace(/-/g, ""));

  // Bare 6-char code: a QR from an older agent, or a code typed without its
  // tail. It still routes; the agent decides what an absent tail is worth.
  const kMatch = /[?&]k=([A-NP-Z1-9]{6})(?:[^A-NP-Z1-9]|$)/i.exec(str);
  if (kMatch) return { tempKey: kMatch[1].toUpperCase() };
  if (/^[A-NP-Z1-9]{6}$/i.test(str)) return { tempKey: str.toUpperCase() };
  return null;
}

// Terminal-glyph laptop + phone hero illustration (brand-tinted, theme-agnostic)
function LoginContent() {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState("");
  const [rememberKey, setRememberKey] = useState(true);
  const [savedKeys, setSavedKeys] = useState([]);
  const [isHydrated, setIsHydrated] = useState(false);
  const [showQRScanner, setShowQRScanner] = useState(false);
  const [authTab, setAuthTab] = useState("local");
  const [editingKeyId, setEditingKeyId] = useState(null);
  const [editingLabel, setEditingLabel] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [loginLoadingKey, setLoginLoadingKey] = useState(null);
  const [localServerKey, setLocalServerKey] = useState(null);
  const version = process.env.NEXT_PUBLIC_SERVER_VERSION;

  const { token: githubToken, clearToken: clearGithubToken } = useGithub();
  const { setAuth } = useSessionStorage();

  const searchParams = useSearchParams();
  const router = useRouter();
  const { loading, error, authenticateWithToken, authenticateWithApiKey } = useAuth();
  // A wrong TAIL only surfaces after login — the Worker clears the key by its
  // HEAD, and the agent is what proves the rest. useSocket parks the reason in
  // sessionStorage and sends the user back; the hydration effect below reads it
  // (reading during the first render would disagree with the server's HTML).
  const [tailRejected, setTailRejected] = useState(false);
  const { loadKeys, saveKey, removeKey, renameKey, hasStoredKeys, updateLastLogin } = useApiKeyStorage();

  // Check for token (old) or temp key (new) in URL (QR code auth).
  // The v2 pairing code rides the #fragment (never sent to the server); the
  // ?k= query stays supported for legacy-agent QRs. Parsed once — the value is
  // stashed in sessionStorage because StrictMode remounts re-run the
  // initializer after the URL has already been scrubbed.
  const token = useMemo(() => searchParams.get("t"), [searchParams]);
  const [tempKey] = useState(() => {
    if (typeof window === "undefined") return null;
    try {
      const stashed = sessionStorage.getItem("9remote_url_pairing");
      if (stashed) return stashed;
      const parsed = parsePairingInput(window.location.hash) || parsePairingInput(window.location.search);
      if (parsed?.tempKey) {
        // Stash the whole code, TAIL included: the URL is scrubbed on the next
        // line, and the TAIL is the half that proves this device to the agent.
        sessionStorage.setItem("9remote_url_pairing", parsed.tempKey + (parsed.tail || ""));
        window.history.replaceState(null, "", window.location.pathname);
        return parsed.tempKey + (parsed.tail || "");
      }
    } catch {}
    return null;
  });
  const isTokenAuth = !!token || !!tempKey;

  // Load saved data after hydration (client-side only)
  useEffect(() => {
    const savedPreference = localStorage.getItem("9remote_remember_key_preference");
    setRememberKey(savedPreference !== "false");
    setSavedKeys(loadKeys());
    setIsHydrated(true);
    // Consumed once: useSocket parks it here when the agent refuses the TAIL.
    if (sessionStorage.getItem(LOGIN_ERROR_KEY)) {
      sessionStorage.removeItem(LOGIN_ERROR_KEY);
      setTailRejected(true);
    }
    if (githubToken) {
      setAuthTab("github");
    }

    // Auto-connect when the agent itself serves this page. Port-gated: the web
    // dev server is loopback too, but a page there must log in like any other
    // build — auto-minting a session from the agent's own key would skip the
    // login screen, and that key is exactly what a dev page would be handed.
    if (isLoopbackOrigin() && window.location.port === String(AGENT_PORT)) {
      fetch("/api/ui/state")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.permanentKey) {
            setLocalServerKey(data.permanentKey);
            const isRemoteMode = searchParams.get("mode") === "remote";
            if (isRemoteMode) {
              try { sessionStorage.setItem("9remote_manual_disconnect", "1"); } catch {}
            }
            const manualDisconnect = isRemoteMode || sessionStorage.getItem("9remote_manual_disconnect") === "1";
            if (!manualDisconnect) {
              const fullKey = data.permanentKey;
              const head = headOf(fullKey);
              const tail = tailOf(fullKey);
              setTrust(head, { tail });
              setAuth({
                apiKey: head,
                tunnelUrl: window.location.origin,
                mode: "local",
                tempKey: null,
                localIp: null
              });
              router.push("/workspace/");
            }
          }
        })
        .catch(() => {});
    }
  }, [loadKeys, githubToken, router, setAuth, searchParams]);

  const handleConnectLocalServer = () => {
    if (!localServerKey) return;
    sessionStorage.removeItem("9remote_manual_disconnect");
    const head = headOf(localServerKey);
    const tail = tailOf(localServerKey);
    setTrust(head, { tail });
    setAuth({
      apiKey: head,
      tunnelUrl: window.location.origin,
      mode: "local",
      tempKey: null,
      localIp: null
    });
    router.push("/workspace/");
  };

  const handleGithubAuthenticated = () => {};

  const handleGithubLogout = () => {
    clearGithubToken();
  };

  // Connect to a started codespace using the agent apiKey (set via Codespace secret)
  const handleCodespaceConnect = (cs, apiKey) => {
    const tunnelUrl = buildCodespaceUrl(cs.name);
    setAuth({
      apiKey: headOf(apiKey), // v2 keys route by HEAD; the TAIL stays local
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

  // Handle temp key auth (scanned QR / pairing link). The stashed value is the
  // whole code — six characters of routing plus two of TAIL — so it is split
  // the same way a typed one is, and the TAIL is stored for the agent. Sending
  // all eight to the Worker, and keeping none of them, left the device with
  // nothing to prove itself with and the agent refusing a correct code.
  const authenticateWithTempKey = useCallback(async (stashed) => {
    const parsed = parsePairingInput(stashed);
    const result = await authenticateWithToken(parsed?.tempKey || stashed, true, parsed?.tail);
    // The URL stash served its purpose — drop it so a later /login visit in
    // this tab doesn't replay a consumed key
    try { sessionStorage.removeItem("9remote_url_pairing"); } catch {}
    if (result.success) {
      // The code's TAIL belongs to the CODE, and is proven under it. Writing it
      // against the API key's HEAD would leave that key holding a secret that
      // expires in minutes and was never its own.
      if (parsed?.tail) setTrust(parsed.tempKey, { tail: parsed.tail });
      if (typeof window !== "undefined" && localStorage.getItem("9remote_remember_key_preference") !== "false") {
        sessionStorage.setItem(WANTS_SAVE_KEY, "1");
      }
      router.push("/workspace/");
    }
  }, [authenticateWithToken, router]);

  // One attempt per code, not per effect run: StrictMode (dev) remounts and
  // re-fires this, and the callbacks' identity changes every render — either
  // would double-POST /api/connect with the same one-time key. The ref guards
  // both, and the stash-scrub inside authenticateWithTempKey covers real nav.
  const tokenAuthStarted = useRef(false);
  useEffect(() => {
    if (!token && !tempKey) return;
    if (tokenAuthStarted.current) return;
    tokenAuthStarted.current = true;
    if (token) {
      authenticateWithToken(token);
    } else {
      authenticateWithTempKey(tempKey);
    }
  }, [token, tempKey, authenticateWithToken, authenticateWithTempKey]);

  /**
   * Submit — one flow for both kinds of key.
   *
   * They are the same shape: a routing half the Worker resolves, and a TAIL it
   * never sees, which is proven to the agent directly. Only the lifetime
   * differs — a one-time code's TAIL dies with the code, an API key's lasts as
   * long as the key — and nothing here needs to care about that.
   */
  const handleConnect = async () => {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) return;

    const parsed = parsePairingInput(trimmedKey);
    const isOneTime = !!parsed?.tempKey;

    // The routing half goes to the Worker; the TAIL is kept for the agent.
    const routingKey = isOneTime ? parsed.tempKey : headOf(trimmedKey);
    const tail = isOneTime ? parsed.tail : tailOf(trimmedKey);
    const result = isOneTime
      ? await authenticateWithToken(parsed.tempKey, true, parsed.tail)
      : await authenticateWithApiKey(trimmedKey);
    if (!result.success) return;

    // Stored against the HEAD the agent will be reached by. A one-time login
    // only learns that HEAD from the Worker's answer, so it is bound here
    // rather than before the call.
    const head = isOneTime ? result.apiKey : routingKey;
    // The TAIL is kept under the key it belongs to. A one-time code's TAIL is
    // the CODE's, not the API key's: it expires in minutes, and writing it into
    // the API key's trust entry produced a saved key with a tail that was never
    // valid for it — right until the code died, then permanently wrong.
    //
    // The owner is what has to exist here, not `head`: a code's TAIL is filed
    // under the code, which is in hand before the Worker answers at all.
    const tailOwner = isOneTime ? parsed.tempKey : head;
    if (tail && tailOwner) setTrust(tailOwner, { tail });

    // Not saved yet — parked until the agent accepts the TAIL. Login only
    // proves the Worker knows the HEAD, and a key that cannot connect has no
    // business in the saved list.
    //
    // A one-time login parks nothing: it has no API key TAIL to save, and the
    // code's own TAIL is worthless once the code expires. The agent hands over
    // the real key when it accepts this device, and THAT is what gets saved.
    if (rememberKey && head) {
      // A typed key can be parked as-is. A pairing has no lasting key yet —
      // the agent issues one on acceptance — so only the intent is recorded,
      // and deviceTrust parks the real key when it arrives.
      if (isOneTime) sessionStorage.setItem(WANTS_SAVE_KEY, "1");
      else sessionStorage.setItem(PENDING_SAVE_KEY, trimmedKey);
    }
    router.push("/workspace/");
  };

  // Handle login with saved key
  const handleLoginWithSavedKey = async (key) => {
    if (!key) return;
    // A stored key may be a full v2 key (re-seed its TAIL so a fresh browser
    // profile can answer the agent) or just the HEAD, from a one-time login
    // saved before the TAIL arrived — withTail repairs that entry from the
    // trust store, otherwise the device could no longer prove itself and the
    // agent would hold it for approval on every visit.
    const savedTail = tailOf(key);
    if (savedTail) setTrust(headOf(key), { tail: savedTail });
    const fullKey = savedTail ? key : withTail(key);
    setLoginLoadingKey(key);
    let result;
    try {
      result = await authenticateWithApiKey(fullKey);
    } finally {
      setLoginLoadingKey(null);
    }
    if (result?.success) {
      if (fullKey !== key) saveKey(fullKey); // persist the repaired entry
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

  // Handle QR scan result — may be a bare code or a full login URL.
  // Returns success so the scanner can close itself (or recover on failure).
  const handleQRScan = async (scanned) => {
    const parsed = parsePairingInput(scanned);
    if (!parsed?.tempKey) return false;
    const result = await authenticateWithToken(parsed.tempKey, true, parsed.tail);
    if (!result.success) return false;
    // Same rule as a typed code: the TAIL is the code's, kept under the code.
    if (parsed.tail) setTrust(parsed.tempKey, { tail: parsed.tail });
    if (typeof window !== "undefined" && localStorage.getItem("9remote_remember_key_preference") !== "false") {
      sessionStorage.setItem(WANTS_SAVE_KEY, "1");
    }
    router.push("/workspace/");
    return true;
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
      {isHydrated && isLoopbackOrigin() && (
        <a
          href="/"
          className="fixed top-4 left-4 z-50 inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-text hover:text-white bg-surface-2/90 hover:bg-surface-3 border border-border-subtle rounded-brand-lg backdrop-blur-md transition-all shadow-sm active:scale-[0.97]"
          title="Back to Host QR"
        >
          <Icon name="ChevronLeft" size={15} className="opacity-70" />
          <Icon name="QrCode" size={15} className="text-brand-500" />
          <span>Host QR</span>
        </a>
      )}
      <div className="min-h-screen grid lg:grid-cols-2">
        {/* HERO — hidden on mobile */}
        <section className="hidden lg:flex flex-col justify-between px-12 xl:px-20 py-12 relative overflow-hidden">
          <div className="login-hero-glow" aria-hidden />
          <div className="my-auto max-w-xl relative z-10">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-surface-2/60 border border-border-subtle font-mono text-[11px] text-text-muted mb-7">
              <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse-glow" />
              {t("login.termConnected")} · {t("login.termTunnel")}
            </div>
            <h1 className="text-6xl xl:text-7xl font-extrabold tracking-tight leading-[0.98] mb-6 text-text">
              {t("login.heroLine1")}<br/>
              {t("login.heroLine2")}<br/>
              <span className="login-hero-grad">{t("login.heroLine3")}</span>
            </h1>
            <p className="text-text-muted text-base lg:text-lg leading-relaxed max-w-md mb-8">
              {t("login.tagline")}
            </p>
            <div className="flex flex-wrap gap-2 mb-9">
              {["Terminal", "Desktop", "Files", "WebRTC low-latency", "iOS · Android · Web"].map((c) => (
                <span
                  key={c}
                  className="font-mono text-xs text-text-muted px-3 py-1.5 rounded-full border border-border-subtle"
                >
                  {c}
                </span>
              ))}
            </div>
            {/* mini terminal mock — decorative */}
            <div className="rounded-xl border border-border-subtle bg-surface-2/60 overflow-hidden max-w-md shadow-lg">
              <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border-subtle">
                <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
                <span className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
                <span className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
                <span className="ml-2 font-mono text-[10px] text-text-subtle">dev@mac — zsh</span>
              </div>
              <div className="p-3.5 font-mono text-[12px] leading-relaxed">
                <div><span className="text-text-subtle">➜</span> 9remote start</div>
                <div className="text-text-subtle">↳ tunnel up · pairing open</div>
                <div>
                  <span className="text-brand-500">[ok]</span> <span className="text-text">machine</span> <span className="text-text-subtle">macbook-pro-m3</span>
                </div>
                <div>
                  <span className="text-brand-500">[ok]</span> <span className="text-text">pty</span> <span className="text-text-subtle">daemon v3.1 · 12 warm</span>
                </div>
                <div>
                  <span className="text-[#6aab6a]">●</span> <span className="text-text-subtle">waiting for phone…</span>{" "}
                  <span className="inline-block w-[7px] h-[13px] bg-brand-500 align-middle animate-cursor-blink" />
                </div>
              </div>
            </div>
          </div>
          {/* hero foot */}
          <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-text-subtle pt-8 relative z-10">
            <span>› PTY persistent</span>
            <span>› end-to-end encrypted</span>
            <span>› open source</span>
          </div>
        </section>

        {/* FORM */}
        <section className="flex items-center justify-center p-6 sm:p-10 lg:border-l lg:border-border-subtle lg:bg-surface-1 relative">
          <div className="login-mobile-glow lg:hidden" aria-hidden />
          <div className="relative z-10 w-full max-w-sm space-y-4">

            {/* Header */}
            <div className="flex items-center gap-3 mb-6">
              <img
                src="/icon-192.png"
                alt="9Remote Logo"
                className="w-10 h-10 rounded-[11px] object-contain shadow-lg shadow-brand-500/20"
              />
              <div className="flex-1">
                <h1 className="text-[22px] font-bold tracking-tight text-text leading-none">9Remote</h1>
                {version && <p className="font-mono text-[11px] text-text-subtle mt-1">v{version}</p>}
              </div>
              <LanguageSwitcher />
              <ThemeToggle />
            </div>

            {/* Tagline — mobile-only (hero hidden) */}
            <p className="text-text-muted text-lg font-medium leading-snug pr-4 mb-6 lg:hidden">
              {t("login.tagline")}
            </p>

            {/* Access Key label */}
            <div className="flex items-center gap-2 mb-2.5">
              <Icon name="KeyRound" className="text-text-muted opacity-70" size={14} />
              <span className="text-[13px] font-semibold text-text">{t("login.accessKey")}</span>
            </div>

            {/* Key input */}
            <div className="relative">
              <input
                id="accessKeyInput"
                type="text"
                value={apiKey}
                // Length tells the two kinds apart as they are typed: a one-time
                // code is eight characters and shown upper case, matching the
                // agent's screen; an API key is longer and lower case. The agent
                // folds case when it compares, so this is presentation only and
                // a paste in either case still works.
                onChange={(e) => {
                  const raw = e.target.value;
                  setApiKey(raw.length <= ONE_TIME_CODE_LENGTH ? raw.toUpperCase() : raw.toLowerCase());
                }}
                onKeyDown={(e) => e.key === "Enter" && apiKey && handleConnect()}
                placeholder={t("login.placeholder")}
                className="w-full pl-3.5 pr-20 py-3 bg-surface-2 border border-border-subtle rounded-[10px] font-mono text-sm text-text placeholder-text-subtle focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 transition-all duration-150"
              />
              <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
                {apiKey && (
                  <>
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={handleClearInput}
                      className="w-7 h-7 grid place-items-center rounded-[7px] text-text-subtle hover:bg-surface-3 hover:text-text transition-colors"
                      type="button"
                    >
                      <X size={16} />
                    </button>
                  </>
                )}
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setShowQRScanner(true)}
                  className="w-7 h-7 grid place-items-center rounded-[7px] text-text-subtle hover:bg-surface-3 hover:text-brand-500 transition-colors"
                  type="button"
                  aria-label={t("login.scanQr")}
                >
                  <Icon name="QrCode" size={16} />
                </button>
              </div>
            </div>
            {(error || tailRejected) && (
              <p className="mt-2 text-xs font-mono text-danger">
                {/* useAuth has no i18n context, so its failures come back as
                    markers and are localised here — wrong TAIL (refused at
                    login or after connecting) and agent-offline (the Worker
                    knows the machine is down). Anything else is shown as-is. */}
                {error === "agent-offline" ? t("login.agentOffline")
                  : error && error !== "wrong-key-tail" ? error
                  : t("login.invalidKeyTail")}
              </p>
            )}

            {/* Remember key */}
            <label className="flex items-center gap-2.5 cursor-pointer mt-4 select-none">
              <input
                type="checkbox"
                checked={rememberKey}
                onChange={(e) => handleRememberChange(e.target.checked)}
                className="w-[15px] h-[15px] accent-brand-500"
              />
              <span className="text-[13px] text-text-muted">{t("login.rememberKey")}</span>
            </label>

            {/* Connect */}
            <Button
              variant="primary"
              onClick={handleConnect}
              loading={loading}
              className="btn-cta w-full mt-4"
            >
              <span className="inline-flex items-center justify-center gap-2">
                {t("login.connect")}
                <Icon name="ArrowRight" size={16} />
              </span>
            </Button>

            {/* Saved devices — mock-style list */}
            {isHydrated && savedKeys.length > 0 && (
              <div className="mt-5 pt-5 border-t border-border-subtle">
                <div className="font-mono text-[11px] uppercase tracking-wider text-text-subtle mb-1 px-1">
                  {t("login.savedKeys")}
                </div>
                {savedKeys.map((item) => {
                  const isEditing = editingKeyId === item.id;
                  const isLoading = loginLoadingKey === item.key;
                  return (
                    <div
                      key={item.id}
                      className="flex items-center gap-3 px-1 py-2 rounded-[10px] hover:bg-surface-2 transition-colors cursor-pointer"
                      onClick={() => !isEditing && !isLoading && handleLoginWithSavedKey(item.key)}
                      role="button"
                      tabIndex={0}
                    >
                      {/* laptop icon */}
                      <div className="w-12 h-12 rounded-[12px] bg-surface-2 border border-border-subtle grid place-items-center text-text-muted flex-shrink-0">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-[26px] h-[26px]">
                          <rect x="2" y="4" width="20" height="13" rx="2" />
                          <line x1="2" y1="20" x2="22" y2="20" />
                        </svg>
                      </div>
                      {/* meta */}
                      <div className="flex-1 min-w-0">
                        {isEditing ? (
                          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <input
                              autoFocus
                              value={editingLabel}
                              onChange={(e) => setEditingLabel(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleSaveRename(item.id);
                                if (e.key === "Escape") handleCancelRename();
                              }}
                              placeholder={t("login.namePlaceholder")}
                              className="flex-1 min-w-0 bg-surface-2 border border-brand-500 rounded-md text-text text-[13px] px-2 py-1 outline-none"
                            />
                            <button onClick={() => handleSaveRename(item.id)} className="w-6 h-6 grid place-items-center rounded-md bg-brand-500 text-white" aria-label={t("common.done")}>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3"><polyline points="20 6 9 17 4 12" /></svg>
                            </button>
                            <button onClick={handleCancelRename} className="w-6 h-6 grid place-items-center rounded-md bg-surface-2 text-text-muted" aria-label={t("common.cancel")}>
                              <X size={13} />
                            </button>
                          </div>
                        ) : (
                          <>
                            <div className="text-[13px] font-medium text-text truncate" title={item.label || t("agentSwitcher.unnamed")}>{item.label || t("agentSwitcher.unnamed")}</div>
                            <div className="font-mono text-[11px] text-text-subtle mt-0.5 truncate">{maskApiKey(item.key)}</div>
                          </>
                        )}
                      </div>
                      {/* last login / loading */}
                      {!isEditing && (
                        <span className="font-mono text-[11px] text-text-subtle whitespace-nowrap">
                          {isLoading ? t("agentSwitcher.connecting") : formatLoginDate(item.lastLoginDate)}
                        </span>
                      )}
                      {/* rename / delete */}
                      {!isEditing && (
                        <div className="flex gap-0.5" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => handleStartRename(item)}
                            title={t("common.edit")}
                            className="w-[26px] h-[26px] grid place-items-center rounded-[7px] text-text-subtle hover:bg-surface-3 hover:text-text transition-colors"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                              <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z" />
                            </svg>
                          </button>
                          <button
                            onClick={() => setDeleteTarget(item)}
                            title={t("common.delete")}
                            className="w-[26px] h-[26px] grid place-items-center rounded-[7px] text-text-subtle hover:bg-surface-3 hover:text-danger transition-colors"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Secure badge */}
            <div className="flex items-center justify-center gap-2 pt-1 text-text-subtle">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                <path d="M12 2l9 4v6c0 5-3.8 9.7-9 11-5.2-1.3-9-6-9-11V6l9-4z" />
              </svg>
              <span className="font-mono text-[11px]">{t("login.secureTitle")}</span>
            </div>
          </div>
        </section>
      </div>

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
