"use client";

// Logcat viewer. Filtering runs on the host, so what arrives here is already
// the subset asked for; this only renders and follows the tail.

import { useLayoutEffect, useRef, useState } from "react";
import { Trash2, Pause, Play, Search, Copy, Filter } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { LOG_LEVELS, LOG_LEVEL_CLASS } from "../constants/mobileConfig";

export default function LogcatPanel({ logcat, apps }) {
  const { lines, clear, minLevel, setMinLevel, search, setSearch, packageName, setPackageName, paused, setPaused, includeNoise, setIncludeNoise } = logcat;
  const { t } = useI18n();
  const scrollRef = useRef(null);
  const [follow, setFollow] = useState(true);

  // Only auto-scroll while the user is already at the bottom — scrolling up to
  // read something must not be yanked back by the next batch.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  // Changing a filter replaces what is on screen, so snap back to the tail.
  const refollow = () => { setFollow(true); };

  useLayoutEffect(() => {
    if (!follow || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines, follow]);

  const copyAll = () => {
    const text = lines.map((l) => `${l.time} ${l.level} ${l.tag}: ${l.message}`).join("\n");
    navigator.clipboard?.writeText(text);
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border flex-shrink-0 flex-wrap">
        <select
          value={packageName || ""}
          onChange={(e) => { vibrate(); setPackageName(e.target.value || null); refollow(); }}
          className="bg-surface-2 text-text text-xs rounded-brand px-1.5 py-1 focus:outline-none max-w-[40%]"
          title={t("mobile.filterByApp")}
        >
          <option value="">{t("mobile.allApps")}</option>
          {apps.map((a) => <option key={a.packageName} value={a.packageName}>{a.packageName}</option>)}
        </select>

        <select
          value={minLevel}
          onChange={(e) => { vibrate(); setMinLevel(e.target.value); refollow(); }}
          className="bg-surface-2 text-text text-xs rounded-brand px-1.5 py-1 focus:outline-none"
          title={t("mobile.minLevel")}
        >
          {LOG_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>

        <div className="flex items-center gap-1 bg-surface-2 rounded-brand px-1.5 py-1 flex-1 min-w-[90px]">
          <Search size={12} className="text-text-muted flex-shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("common.search")}
            className="bg-transparent text-xs text-text placeholder:text-text-muted focus:outline-none w-full min-w-0"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>

        <button
          onClick={() => { vibrate(); setPaused(!paused); }}
          className={`p-1.5 rounded-brand transition-colors ${paused ? "text-brand-500 bg-surface-2" : "text-text-muted hover:text-text"}`}
          title={paused ? t("mobile.resumeLog") : t("mobile.pauseLog")}
          aria-label={paused ? t("mobile.resumeLog") : t("mobile.pauseLog")}
        >
          {paused ? <Play size={13} /> : <Pause size={13} />}
        </button>
        <button
          onClick={() => { vibrate(); setIncludeNoise(!includeNoise); refollow(); }}
          className={`p-1.5 rounded-brand transition-colors ${includeNoise ? "text-amber-400 bg-surface-2" : "text-text-muted hover:text-text"}`}
          title={includeNoise ? t("mobile.hideNoise") : t("mobile.showNoise")}
          aria-label={includeNoise ? t("mobile.hideNoise") : t("mobile.showNoise")}
        >
          <Filter size={13} />
        </button>
        <button
          onClick={() => { vibrate(); copyAll(); }}
          className="p-1.5 text-text-muted hover:text-text rounded-brand transition-colors"
          title={t("common.clipboardCopy")}
          aria-label={t("common.clipboardCopy")}
        >
          <Copy size={13} />
        </button>
        <button
          onClick={() => { vibrate(); clear(); }}
          className="p-1.5 text-text-muted hover:text-red-400 rounded-brand transition-colors"
          title={t("mobile.clearLog")}
          aria-label={t("mobile.clearLog")}
        >
          <Trash2 size={13} />
        </button>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-auto modal-scrollable font-mono text-[11px] leading-[1.45] p-2"
      >
        {lines.length === 0 && (
          <p className="text-text-muted text-xs text-center py-6 font-sans">{t("mobile.noLogs")}</p>
        )}
        {lines.map((l) => (
          <div key={l.seq} className="whitespace-pre-wrap break-all">
            <span className="text-text-muted/60">{l.time}</span>
            {" "}
            <span className={LOG_LEVEL_CLASS[l.level] || "text-text"}>{l.level}</span>
            {" "}
            <span className="text-brand-500/70">{l.tag}</span>
            {l.tag ? ": " : ""}
            <span className={LOG_LEVEL_CLASS[l.level] || "text-text"}>{l.message}</span>
          </div>
        ))}
      </div>

      {paused && (
        <div className="px-2 py-1 text-[11px] text-amber-400 bg-amber-400/10 flex-shrink-0 text-center">
          {t("mobile.logPaused")}
        </div>
      )}
    </div>
  );
}
