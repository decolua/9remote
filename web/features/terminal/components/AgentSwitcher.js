"use client";

import { useState, useCallback, useEffect } from "react";
import { Pencil, Trash2, Check, X } from "@/shared/components/ui/Icon";
import { maskApiKey } from "@/shared/utils/formatters";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { useApiKeyStorage } from "@/shared/hooks/useApiKeyStorage";

// Deterministic accent per card slot — stable color regardless of key order changes
const ACCENTS = [
  { name: "indigo", rgb: "99,102,241", angle: "0% 0%" },
  { name: "green", rgb: "34,197,94", angle: "100% 0%" },
  { name: "amber", rgb: "245,158,11", angle: "0% 100%" },
  { name: "pink", rgb: "236,72,153", angle: "100% 100%" },
  { name: "cyan", rgb: "6,182,212", angle: "50% 0%" }
];

const accentOf = (i) => ACCENTS[i % ACCENTS.length];

// Relative time label
function relTime(iso, t) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1) return t("login.justNow");
  if (m < 60) return t("login.minutesAgo", { n: m });
  if (h < 24) return t("login.hoursAgo", { n: h });
  if (d < 7) return t("login.daysAgo", { n: d });
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Pure-CSS MacBook illustration; accent tints the screen glow + active code line
function MacBook({ accent }) {
  return (
    <div className="as-mac" style={{ "--accent-rgb": accent.rgb, "--accent-angle": accent.angle }}>
      <div className="as-mac__screen">
        <span className="as-mac__cam" />
        <div className="as-mac__desk">
          <div className="as-mac__bar"><i /><i /><i /></div>
          <div className="as-mac__lns">
            <span className="as-mac__ln a" />
            <span className="as-mac__ln b" />
            <span className="as-mac__ln c" />
            <span className="as-mac__ln b" />
          </div>
        </div>
      </div>
      <div className="as-mac__base"><span className="as-mac__notch" /></div>
    </div>
  );
}

/**
 * AgentSwitcher — card grid of saved API keys rendered as colored MacBooks.
 * variant="login": inline block replacing the saved-keys list.
 * variant="menu":  fixed-bottom dock inside the slide menu (shown only when >1 key).
 *
 * Edit mode (pencil in header): cards wiggle, labels become rename inputs,
 * each card gets a delete (×) button. Tap a card outside edit mode = connect.
 */
export default function AgentSwitcher({
  variant = "login",
  keys = [],
  currentApiKey = null,
  onSelect,
  loadingKey = null
}) {
  const { t } = useI18n();
  const { renameKey, removeKey, loadKeys } = useApiKeyStorage();
  // Local copy so rename/delete reflect immediately without parent re-render
  const [localKeys, setLocalKeys] = useState(keys);
  useEffect(() => { setLocalKeys(keys); }, [keys]);
  const refresh = useCallback(() => setLocalKeys(loadKeys()), [loadKeys]);

  const [editMode, setEditMode] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState(null);

  const enterRename = useCallback((item) => {
    setEditingId(item.id);
    setDraft(item.label || "");
  }, []);

  const commitRename = useCallback(() => {
    if (editingId) {
      renameKey(editingId, draft.trim());
      refresh();
    }
    setEditingId(null);
  }, [editingId, draft, renameKey, refresh]);

  const confirmDelete = useCallback(() => {
    if (!pendingDelete) return;
    removeKey(pendingDelete.id);
    refresh();
    setPendingDelete(null);
  }, [pendingDelete, removeKey, refresh]);

  if (!localKeys.length) return null;

  const isMenu = variant === "menu";

  return (
    <>
    <div className={isMenu ? "as-menu" : "as-login"}>
      <div className="as-head">
          <h3>{t("agentSwitcher.title")}</h3>
          <button
            type="button"
            onClick={() => { vibrate(); setEditMode((v) => !v); setEditingId(null); }}
            className={`as-edit-btn ${editMode ? "as-edit-btn--on" : ""}`}
            aria-label={editMode ? t("common.done") : t("common.edit")}
            title={editMode ? t("common.done") : t("common.edit")}
          >
            {editMode ? <Check size={15} /> : <Pencil size={15} />}
          </button>
        </div>

        <div className={`as-row ${editMode ? "as-row--edit" : ""}`}>
          {localKeys.map((item, i) => {
            const accent = accentOf(i);
            const isActive = !isMenu && currentApiKey && item.key === currentApiKey;
            const isEditing = editingId === item.id;
            const isLoading = loadingKey === item.key;
            return (
              <div
                key={item.id}
                className={`as-card ${isActive ? "as-card--active" : ""}`}
                style={{ "--accent-rgb": accent.rgb, "--accent-angle": accent.angle }}
                onClick={() => {
                  if (editMode || isEditing) return;
                  vibrate();
                  onSelect?.(item.key);
                }}
                role="button"
                tabIndex={0}
              >
                {isActive && (
                  <span className="as-on">
                    <span className="as-pulse" />
                    <span className="as-on-tx">{t("agentSwitcher.active")}</span>
                  </span>
                )}
                {editMode && !isEditing && (
                  <button
                    type="button"
                    className="as-del"
                    onClick={(e) => { e.stopPropagation(); vibrate(); setPendingDelete(item); }}
                    aria-label={t("common.delete")}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
                <div className="as-mac-wrap">
                  <MacBook accent={accent} />
                </div>
                {isEditing ? (
                  <div className="as-rename" onClick={(e) => e.stopPropagation()}>
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      placeholder={t("login.namePlaceholder")}
                      className="as-rename-input"
                    />
                    <button type="button" className="as-rename-ok" onClick={commitRename}><Check size={13} /></button>
                    <button type="button" className="as-rename-x" onClick={() => setEditingId(null)}><X size={13} /></button>
                  </div>
                ) : (
                  <>
                    <div
                      className={`as-lbl ${editMode ? "as-lbl--edit" : ""}`}
                      onClick={editMode ? (e) => { e.stopPropagation(); vibrate(); enterRename(item); } : undefined}
                    >
                      {item.label || t("agentSwitcher.unnamed")}
                    </div>
                    <div className="as-sub">
                      {isLoading ? t("agentSwitcher.connecting") : relTime(item.lastLoginDate, t)}
                    </div>
                    <div className="as-key" title={item.key}>{maskApiKey(item.key)}</div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {pendingDelete && (
        <div className="as-confirm-overlay" onClick={() => setPendingDelete(null)}>
          <div className="as-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="as-confirm-icon"><Trash2 size={22} /></div>
            <h4>{t("login.deleteKeyTitle")}</h4>
            <p>{t("login.deleteKeyConfirm", { name: pendingDelete.label })}</p>
            <div className="as-confirm-actions">
              <button type="button" className="as-confirm-cancel" onClick={() => setPendingDelete(null)}>
                {t("common.cancel")}
              </button>
              <button type="button" className="as-confirm-del" onClick={confirmDelete}>
                {t("common.delete")}
              </button>
            </div>
          </div>
        </div>
      )}

      <style jsx global>{`
        .as-login{padding:0}
        .as-menu{position:fixed;left:0;right:0;bottom:0;z-index:40;padding:8px 12px calc(8px + env(safe-area-inset-bottom))}
        .as-head{display:flex;align-items:center;justify-content:space-between;padding:0 6px 8px}
        .as-head h3{margin:0;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--text-muted,#8b95a5);font-weight:700}
        .as-edit-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;color:var(--text-muted,#8b95a5);background:transparent;border:0;cursor:pointer;transition:all .15s ease}
        .as-edit-btn:hover{background:var(--surface-2,#1a2029);color:var(--text,#e7ebf0)}
        .as-edit-btn--on{background:rgba(var(--brand-rgb,99,102,241),.18);color:#a5a8ff}
        .as-row{display:flex;gap:12px;overflow-x:auto;padding:2px 4px 6px;scrollbar-width:thin;scroll-snap-type:x mandatory}
        .as-row::-webkit-scrollbar{height:5px}
        .as-row::-webkit-scrollbar-thumb{background:#2a313d;border-radius:99px}
        .as-row--edit .as-card{animation:as-wiggle 2.4s ease-in-out infinite}
        .as-row--edit .as-card:nth-child(2n){animation-delay:.2s}
        .as-row--edit .as-card:nth-child(3n){animation-delay:.4s}
        @keyframes as-wiggle{0%,100%{transform:rotate(-1.1deg)}50%{transform:rotate(1.1deg)}}

        .as-card{position:relative;flex:0 0 auto;width:128px;scroll-snap-align:center;padding:6px 8px 9px;border-radius:16px;cursor:pointer;background:transparent;border:1.5px solid transparent;transition:transform .2s ease,border-color .2s ease}
        .as-card:hover{transform:translateY(-3px)}
        .as-card--active{border-color:rgb(var(--accent-rgb));box-shadow:0 0 0 3px rgba(var(--accent-rgb),.22)}
        .as-card--active:hover{transform:translateY(-3px) rotate(-1deg)}

        .as-on{position:absolute;top:7px;right:7px;display:inline-flex;align-items:center;gap:4px}
        .as-pulse{width:6px;height:6px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 0 rgba(34,197,94,.6);animation:as-pulse 1.8s infinite}
        .as-on-tx{font-size:8.5px;color:#22c55e;font-weight:700;letter-spacing:.04em}
        @keyframes as-pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.55)}70%{box-shadow:0 0 0 6px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}

        .as-del{position:absolute;top:6px;right:6px;width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:#ef4444;color:#fff;border:2px solid var(--bg,#0a0d12);cursor:pointer;z-index:2;box-shadow:0 2px 6px rgba(0,0,0,.4)}
        .as-card--active .as-del{border-color:rgb(var(--accent-rgb))}

        .as-mac-wrap{display:flex;justify-content:center}

        /* MacBook */
        .as-mac{width:104px;position:relative;filter:drop-shadow(0 8px 12px rgba(0,0,0,.5))}
        .as-mac__screen{position:relative;width:100%;aspect-ratio:16/10;background:#0b0f14;border-radius:8px 8px 3px 3px;padding:4px 4px 6px;border:1.5px solid #3a4250;border-bottom-width:6px}
        .as-mac__cam{position:absolute;top:2.5px;left:50%;transform:translateX(-50%);width:3.5px;height:3.5px;border-radius:50%;background:#0b0f14;border:1px solid #2a313d}
        .as-mac__desk{width:100%;height:100%;border-radius:3px;overflow:hidden;display:flex;flex-direction:column;background:radial-gradient(120% 100% at var(--accent-angle),rgba(var(--accent-rgb),.3),transparent 55%),linear-gradient(160deg,#16202c,#0d1218)}
        .as-mac__bar{height:7px;background:rgba(255,255,255,.06);display:flex;align-items:center;gap:3px;padding:0 4px}
        .as-mac__bar i{width:3px;height:3px;border-radius:50%;background:#ffffff33}
        .as-mac__lns{padding:5px 5px 0;display:flex;flex-direction:column;gap:2.5px;flex:1}
        .as-mac__ln{height:2.5px;border-radius:2px;background:rgba(255,255,255,.16)}
        .as-mac__ln.a{width:65%;background:rgb(var(--accent-rgb))}
        .as-mac__ln.b{width:42%}
        .as-mac__ln.c{width:55%}
        .as-mac__base{position:relative;height:6px;margin:0 -3px;background:linear-gradient(180deg,#c8ccd2,#9aa0aa);border-radius:0 0 8px 8px;box-shadow:0 3px 5px rgba(0,0,0,.4)}
        .as-mac__notch{position:absolute;left:50%;top:0;transform:translateX(-50%);width:30%;height:2.5px;background:#7b818b;border-radius:0 0 5px 5px}

        .as-lbl{font-size:14px;font-weight:600;text-align:center;margin-top:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .as-lbl--edit{cursor:text;border-bottom:1px dashed var(--text-muted,#8b95a5)}
        .as-sub{font-size:11px;color:var(--text-muted,#8b95a5);text-align:center;margin-top:2px}
        .as-key{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--text-muted,#8b95a5);opacity:.75;text-align:center;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.02em}

        .as-rename{display:flex;align-items:center;gap:3px;margin-top:8px;padding:0 2px}
        .as-rename-input{flex:1;min-width:0;background:var(--surface-2,#1a2029);border:1px solid rgb(var(--accent-rgb));border-radius:6px;color:var(--text,#e7ebf0);font-size:11px;padding:3px 5px;text-align:center}
        .as-rename-input:focus{outline:none}
        .as-rename-ok,.as-rename-x{flex-shrink:0;width:20px;height:20px;border-radius:6px;border:0;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
        .as-rename-ok{background:rgb(var(--accent-rgb));color:#fff}
        .as-rename-x{background:var(--surface-2,#1a2029);color:var(--text-muted,#8b95a5)}

        .as-confirm-overlay{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.6);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;padding:16px}
        .as-confirm{max-width:340px;width:100%;background:var(--surface,#12161d);border:1px solid var(--border,#262e3a);border-radius:18px;padding:22px 20px;text-align:center}
        .as-confirm-icon{width:52px;height:52px;margin:0 auto 12px;border-radius:50%;background:rgba(239,68,68,.15);color:#ef4444;display:flex;align-items:center;justify-content:center}
        .as-confirm h4{margin:0 0 6px;font-size:17px;font-weight:700;color:var(--text,#e7ebf0)}
        .as-confirm p{margin:0 0 18px;font-size:13.5px;color:var(--text-muted,#8b95a5)}
        .as-confirm-actions{display:flex;gap:8px}
        .as-confirm-cancel{flex:1;padding:10px;border-radius:10px;background:var(--surface-2,#1a2029);color:var(--text,#e7ebf0);border:0;font-weight:600;font-size:14px;cursor:pointer}
        .as-confirm-del{flex:1;padding:10px;border-radius:10px;background:#ef4444;color:#fff;border:0;font-weight:600;font-size:14px;cursor:pointer}
      `}</style>
    </>
  );
}
