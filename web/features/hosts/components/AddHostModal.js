"use client";

import { useEffect, useRef, useState } from "react";
import { KeyRound, Loader2, X } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { useAuth } from "@/shared/hooks/useAuth";
import { useApiKeyStorage } from "@/shared/hooks/useApiKeyStorage";
import { headOf, tailOf, isLegacyApiKey } from "@/shared/utils/apiKey";
import { setTrust } from "@/shared/transport/lib/deviceTrust";
import { parsePairingInput } from "../lib/parsePairingInput";

// Add another machine: a pasted access key, or a pairing code read off the host's
// screen. Both paths end in a real authentication, so a wrong key is caught here
// rather than at the next workspace load.
export default function AddHostModal({ onClose }) {
  const { t } = useI18n();
  const { authenticateWithApiKey, authenticateWithToken } = useAuth();
  const { saveKey } = useApiKeyStorage();
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    // No autofocus on touch — the keyboard shoves the centered modal up abruptly.
    if (!window.matchMedia("(pointer: fine)").matches) return;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose?.();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const submit = async (e) => {
    e?.preventDefault();
    const raw = value.trim();
    if (!raw || busy) return;
    if (isLegacyApiKey(raw)) return setError(t("login.legacyKeyError"));

    vibrate();
    setBusy(true);
    setError("");
    // The same two shapes the login page accepts: a pairing code routes through the
    // agent's temp key, anything else is an access key.
    const parsed = parsePairingInput(raw);
    try {
      const result = parsed?.tempKey
        ? await authenticateWithToken(parsed.tempKey, true, parsed.tail)
        : await authenticateWithApiKey(raw);
      if (!result?.success) {
        setError(result?.error && result.error !== "wrong-key-tail"
          ? result.error
          : t("login.invalidKeyTail"));
        return;
      }
      const head = parsed?.tempKey ? result.apiKey : headOf(raw);
      const tail = parsed?.tempKey ? parsed.tail : tailOf(raw);
      if (tail && head) setTrust(parsed?.tempKey || head, { tail });
      if (remember && head) saveKey(parsed?.tempKey ? result.apiKey : raw, "");
      // Authentication wrote the new auth to session storage — a reload is what
      // actually rebinds the bus to the new host.
      window.location.href = "/workspace/";
    } catch (err) {
      setError(err?.message || t("login.invalidKeyTail"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center px-4 bg-black/50 backdrop-blur-[4px] animate-in fade-in duration-150"
      style={{ paddingTop: "max(1rem, env(safe-area-inset-top))", paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      onClick={onClose}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label={t("hosts.addHost")}
        onSubmit={submit}
        className="card-elev w-[26rem] max-w-full overflow-hidden flex flex-col my-auto animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-4 pb-3 flex items-center gap-2.5 border-b border-border-subtle">
          <div className="p-1.5 bg-brand-500/10 rounded-brand flex-shrink-0">
            <KeyRound className="text-brand-500 w-4 h-4" />
          </div>
          <h2 className="flex-1 text-sm font-semibold text-text truncate">{t("hosts.addHost")}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.cancel")}
            className="text-text-muted hover:text-text shrink-0"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-4 py-4 space-y-3">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => { setValue(e.target.value); setError(""); }}
            placeholder={t("login.placeholder")}
            spellCheck={false}
            autoComplete="off"
            className="w-full px-3 py-2.5 bg-surface-2 border border-border-subtle rounded-[10px] font-mono text-sm text-text placeholder-text-subtle focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 transition-all duration-150"
          />
          <label className="flex items-center gap-2 px-0.5 text-xs text-text-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="w-4 h-4 accent-brand-500 cursor-pointer"
            />
            {t("login.rememberKey")}
          </label>
          {error && <p className="text-xs text-red-400 px-0.5">{error}</p>}
        </div>

        <div className="px-4 pb-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2 text-sm text-text-muted bg-surface-2 hover:bg-surface-3 rounded-brand transition-colors"
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            disabled={!value.trim() || busy}
            className="flex-1 py-2 text-sm font-semibold text-white bg-brand-500 hover:bg-brand-600 rounded-brand transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {t("login.connect")}
          </button>
        </div>
      </form>
    </div>
  );
}
