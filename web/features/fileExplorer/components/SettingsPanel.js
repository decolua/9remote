"use client";

import { vibrate } from "@/shared/utils/vibration";
import {
  STORAGE_KEYS,
  EDITOR_FONT_DEFAULT,
  EDITOR_FONT_MIN,
  EDITOR_FONT_MAX,
  AUTO_SAVE_MODES
} from "../constants/fileExplorer.js";
import { usePersistedState } from "@/shared/hooks/usePersistedState";

const SHOW_HIDDEN_KEY = "fileExplorer.showHidden";

const SECTION_CLS = "px-3 my-2 text-[11px] uppercase tracking-wider text-text-muted";
const ROW_CLS = "flex items-center justify-between px-3 py-2 hover:bg-surface-2";

function Toggle({ value, onChange }) {
  return (
    <button
      type="button"
      onClick={() => { vibrate(); onChange(!value); }}
      className={`relative w-9 h-5 rounded-full transition-colors ${value ? "bg-brand-500" : "bg-surface-3"}`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${value ? "translate-x-4" : "translate-x-0.5"}`}
      />
    </button>
  );
}

export default function SettingsPanel() {
  const [fontSize, setFontSize] = usePersistedState(STORAGE_KEYS.editorFontSize, EDITOR_FONT_DEFAULT);
  const [wordWrap, setWordWrap] = usePersistedState(STORAGE_KEYS.wordWrap, false);
  const [autoSave, setAutoSave] = usePersistedState(STORAGE_KEYS.autoSaveMode, AUTO_SAVE_MODES.off);
  const [showHidden, setShowHidden] = usePersistedState(SHOW_HIDDEN_KEY, false);

  // Clamp font-size to allowed range
  const updateFontSize = (n) => {
    const v = Math.max(EDITOR_FONT_MIN, Math.min(EDITOR_FONT_MAX, Number(n) || EDITOR_FONT_DEFAULT));
    setFontSize(v);
  };

  return (
    <div className="flex flex-col h-full text-sm text-text overflow-auto">
      <div className={SECTION_CLS}>Editor</div>

      <div className={ROW_CLS}>
        <span className="text-xs text-text">Font Size</span>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={EDITOR_FONT_MIN}
            max={EDITOR_FONT_MAX}
            value={fontSize}
            onChange={(e) => updateFontSize(e.target.value)}
            className="w-24 accent-brand-500"
          />
          <input
            type="number"
            min={EDITOR_FONT_MIN}
            max={EDITOR_FONT_MAX}
            value={fontSize}
            onChange={(e) => updateFontSize(e.target.value)}
            className="w-12 bg-surface-2 border border-border rounded-brand px-1 h-6 text-xs text-text text-center focus:outline-none focus:border-brand-500"
          />
        </div>
      </div>

      <div className={ROW_CLS}>
        <span className="text-xs text-text">Word Wrap</span>
        <Toggle value={wordWrap} onChange={setWordWrap} />
      </div>

      <div className={ROW_CLS}>
        <span className="text-xs text-text">Auto Save</span>
        <select
          value={autoSave}
          onChange={(e) => { vibrate(); setAutoSave(e.target.value); }}
          className="bg-surface-2 border border-border rounded-brand px-2 h-7 text-xs text-text focus:outline-none focus:border-brand-500"
        >
          <option value={AUTO_SAVE_MODES.off}>Off</option>
          <option value={AUTO_SAVE_MODES.afterDelay}>After Delay</option>
          <option value={AUTO_SAVE_MODES.onFocusChange}>On Focus Change</option>
        </select>
      </div>

      <div className={SECTION_CLS}>Files</div>

      <div className={ROW_CLS}>
        <span className="text-xs text-text">Show Hidden Files</span>
        <Toggle value={showHidden} onChange={setShowHidden} />
      </div>

      <div className={SECTION_CLS}>About</div>

      <div className="px-3 py-2 text-xs text-text-muted">
        VSCode-like File Explorer for 9remote
      </div>
    </div>
  );
}
