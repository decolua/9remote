"use client";

import { memo } from "react";
import { Settings } from "@/shared/components/ui/Icon";
import { ModalShell } from "@/features/ai/components/modals/ModalShell";
import { JarvisConfigPanel } from "@/features/jarvis/components/JarvisConfigPanel";

/**
 * The in-view gear modal — a thin shell around JarvisConfigPanel, which is the
 * same configuration the settings dialog's Jarvis section shows.
 */
export const JarvisSettingsModal = memo(function JarvisSettingsModal({ busRef, onClose }) {
  return (
    <ModalShell
      icon={<Settings size={14} />}
      iconClass="bg-surface-3 text-text-muted"
      title="Jarvis Settings"
      subtitle="Coordinator harness and behavior"
      maxWidth="max-w-sm"
      onClose={onClose}
    >
      <div className="p-3">
        <JarvisConfigPanel busRef={busRef} />
      </div>
    </ModalShell>
  );
});
