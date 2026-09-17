import { useRef, useState } from "react";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { fileToScaledDataUrl } from "@/features/terminal/lib/backgroundImage";
import { BG_SAVE_TIMEOUT_MS } from "@/features/terminal/constants/terminalConfig";

// Pick an image, hand it to the agent (bg:save compresses + stores it) and add the
// returned item to the shared list. Shared by the settings sheet and the per-tab
// picker so both doors save, select and fail the same way.
export default function useBackgroundPicker(busRef) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef(null);

  const saveBackground = (dataUrl) => {
    const bus = busRef?.current;
    if (!bus?.emit) { setError(t("menu.bgSaveFailed")); return; }
    setSaving(true);
    setError("");
    let done = false;
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); setSaving(false); fn(); };
    const timer = setTimeout(() => finish(() => setError(t("menu.bgSaveFailed"))), BG_SAVE_TIMEOUT_MS);
    bus.emit("bg:save", { dataUrl }, (res) => {
      finish(() => {
        if (res?.success && res.id && res.dataUrl) {
          const key = `custom:${res.id}`;
          const { customBackgrounds: list, setCustomBackgrounds, terminalBackgrounds: keys, setTerminalBackgrounds: setKeys } = useTerminalStore.getState();
          setCustomBackgrounds([...list, { id: res.id, dataUrl: res.dataUrl }]);
          if (!keys.includes(key)) setKeys([...keys, key]);
          vibrate();
        } else {
          setError(res?.error || t("menu.bgSaveFailed"));
        }
      });
    });
  };

  const handlePickFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || saving) return;
    try {
      saveBackground(await fileToScaledDataUrl(file));
    } catch {
      setError(t("menu.bgSaveFailed"));
    }
  };

  const openPicker = () => {
    vibrate();
    if (!saving) fileInputRef.current?.click();
  };

  // Hidden file input the caller renders — one picker per hook instance
  const fileInput = (
    <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handlePickFile} />
  );

  return { saving, error, setError, fileInput, openPicker };
}
