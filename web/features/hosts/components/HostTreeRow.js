"use client";

import { useState } from "react";
import { ChevronRight, Folder, KeyRound, Monitor, Pencil, Power, RotateCw, Trash2 } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import PromptDialog from "@/shared/components/ui/PromptDialog";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import IconMenu from "@/shared/components/ui/IconMenu";
import AddHostModal from "./AddHostModal";

// Hidden until the row is hovered on desktop; full opacity on touch/mobile so it
// matches the workspace and session rows below.

/**
 * The host row — the root of a workspace tree, shared by the desktop sidebar and the
 * mobile session list so both screens draw a machine the same way. The label toggles
 * the tree (it is a tree node, not a button to a picker); the glyph + dot are identity,
 * not a button.
 *
 * Owns its dialogs, so a caller only wires the four actions it can actually perform.
 */
export default function HostTreeRow({
  hostKey = null,
  label = "",
  connected = true,
  collapsed = false,
  onToggleCollapse = null,
  onRename = null,
  onDelete = null,
  onDisconnect = null,
  onAddWorkspace = null,
  // Other-host roots: a status tail, a grey (not red) offline dot, and a bus retry.
  meta = null,
  mutedOffline = false,
  connecting = false,
  onRetry = null,
  // The desktop sidebar keeps its add-key button up in the brand row instead.
  showAdd = true,
  // Mobile draws this row bigger (fonts on the standard scale, touch-sized
  // buttons); desktop keeps its compact sizes.
  mobile = false,
  className = ""
}) {
  const { t } = useI18n();
  const [rename, setRename] = useState(null);   // draft label while renaming
  const [removeOpen, setRemoveOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [menuAt, setMenuAt] = useState(null); // screen pos a right-click opened the menu at

  const displayLabel = label || "Local";

  return (
    <>
      <div
        className={`relative pr-2 ${mobile ? "py-1.5" : "py-1"} flex items-center gap-1 group group/host ${className}`}
        onContextMenu={(e) => { e.preventDefault(); vibrate(); setMenuAt({ left: e.clientX, top: e.clientY }); }}
      >
        {onToggleCollapse ? (
          <button
            onClick={(e) => { e.stopPropagation(); vibrate(); onToggleCollapse(); }}
            className="p-1 text-text-subtle hover:text-text flex-shrink-0"
            tabIndex={-1}
            aria-expanded={!collapsed}
            aria-label={displayLabel}
          >
            <ChevronRight size={12} className={`transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`} />
          </button>
        ) : (
          // Same box, invisible — every host row's glyph stays at the same x even
          // when a row cannot expand (an offline host).
          <span className="p-1 flex-shrink-0 invisible" aria-hidden="true">
            <ChevronRight size={12} />
          </span>
        )}
        {/* Every host row carries the machine glyph + connection dot — the identity
            of a row, not a button. */}
        <span className="relative flex-shrink-0">
          <Monitor size={mobile ? 16 : 15} className="text-text-muted" />
          <span className={`absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ring-1 ring-surface ${connecting ? "bg-amber-400 animate-pulse" : connected ? "bg-green-500" : mutedOffline ? "bg-text-subtle" : "bg-red-500 animate-pulse"}`} />
        </span>
        <button
          type="button"
          onClick={() => { if (onToggleCollapse) { vibrate(); onToggleCollapse(); } }}
          className="flex-1 min-w-0 py-0.5 pr-1 text-left"
        >
          <span className={`block ${mobile ? "text-sm" : "text-[12px]"} font-medium uppercase truncate ${connected ? "text-text" : "text-text-muted"}`} data-tip={displayLabel}>
            {displayLabel}
          </span>
        </button>
        {meta && <span className="text-[10px] text-text-subtle truncate min-w-0 max-w-[45%] mr-1">{meta}</span>}

        {/* Actions pinned absolute right — the ExplorerRow door: text runs full
            width, hover floats the cluster over its end with a surface backdrop. */}
        <div className={`absolute right-1 top-1/2 -translate-y-1/2 flex items-center ${mobile ? "gap-1.5" : "gap-1 sm:gap-1.5"} px-1 rounded-[3px] bg-surface-2 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 [@media(hover:none)]:bg-transparent [@media(hover:none)]:px-0 transition-opacity`}>
          {showAdd && (
            <button
              onClick={(e) => { e.stopPropagation(); vibrate(); setAddOpen(true); }}
              className="p-0.5 text-text-subtle hover:text-text rounded-[2px] transition-colors"
              title={t("hosts.addHost")}
            >
              <KeyRound size={13.5} />
            </button>
          )}
          {/* Retry an offline host's background bus without switching to it. */}
          {onRetry && !connected && !connecting && (
            <button
              onClick={(e) => { e.stopPropagation(); vibrate(); onRetry(); }}
              className={`${mobile ? "p-1.5" : "p-0.5"} text-text-subtle hover:text-text rounded-[2px] transition-colors`}
              title={t("common.retry")}
            >
              <RotateCw size={mobile ? 16 : 13} />
            </button>
          )}
          {/* New workspace — its own folder button, one tap shallower than the menu. */}
          {onAddWorkspace && (
            <button
              onClick={(e) => { e.stopPropagation(); vibrate(); onAddWorkspace(); }}
              className={`${mobile ? "p-1.5" : "p-0.5"} text-text-subtle hover:text-text rounded-[2px] transition-colors`}
              title={t("workspaces.newWorkspace")}
            >
              <Folder size={mobile ? 18 : 13.5} />
            </button>
          )}
          {/* Rename / delete / disconnect folded into one "..." — the key icon stays
              out front because adding a machine is the frequent action. Right-clicking
              the row opens the same menu. */}
          <IconMenu
            size={mobile ? 18 : 13.5}
            label={t("sessions.sessionActions")}
            revealCls=""
            anchor={menuAt}
            onClose={() => setMenuAt(null)}
            items={[
              onRename && hostKey && {
                icon: Pencil, label: t("sessions.editName"),
                onClick: () => setRename(displayLabel)
              },
              onDelete && hostKey && {
                icon: Trash2, label: t("hosts.removeHost"), danger: true,
                onClick: () => setRemoveOpen(true)
              },
              onDisconnect && {
                icon: Power, label: t("common.disconnect"), danger: true,
                onClick: () => setDisconnectOpen(true)
              }
            ]}
          />
        </div>
      </div>

      {addOpen && <AddHostModal onClose={() => setAddOpen(false)} />}

      {rename !== null && (
        <PromptDialog
          title={t("sessions.editName")}
          placeholder={displayLabel}
          value={rename}
          onChange={setRename}
          onSubmit={() => {
            const next = rename.trim();
            if (next && hostKey) onRename?.(hostKey, next);
            setRename(null);
          }}
          onClose={() => setRename(null)}
        />
      )}

      <ConfirmDialog
        isOpen={removeOpen}
        onClose={() => setRemoveOpen(false)}
        onConfirm={() => {
          setRemoveOpen(false);
          if (hostKey) onDelete?.(hostKey);
        }}
        title={t("hosts.removeHost")}
        message={t("hosts.removeHostMessage", { name: displayLabel })}
        confirmText={t("common.delete")}
      />

      <ConfirmDialog
        isOpen={disconnectOpen}
        onClose={() => setDisconnectOpen(false)}
        onConfirm={() => { setDisconnectOpen(false); onDisconnect?.(); }}
        title={t("common.disconnect")}
        message={t("hosts.disconnectMessage", { name: displayLabel })}
        confirmText={t("common.disconnect")}
      />
    </>
  );
}
