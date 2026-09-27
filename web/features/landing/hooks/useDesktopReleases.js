"use client";

import { useSyncExternalStore } from "react";
import { GITHUB_RELEASES_API } from "@/shared/constants/github";
import { INSTALLERS } from "../constants/landingConfig";

const STORAGE_KEY = "9remote_desktop_releases";
const CACHE_TTL_MS = 60 * 60 * 1000;

// A release only counts when it ships every installer under its expected name.
// That is what keeps the archive tags out — they carry no desktop assets at all.
const isDesktopRelease = (rel) =>
  !rel.draft && !rel.prerelease &&
  INSTALLERS.every((i) => rel.assets?.some((a) => a.name === i.asset));

const toEntry = (rel) => ({ tag: rel.tag_name, date: (rel.published_at || "").slice(0, 10) });

/* One shared fetch for the whole page: /download and the landing's own download
   button both read this list, and neither should be the one that owns it. */
let cache = null; // Release[] once loaded, or null while unknown
let inflight = null;
const listeners = new Set();

function emit() { for (const l of listeners) l(); }

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const { releases, timestamp } = JSON.parse(raw);
    if (!Array.isArray(releases) || !releases.length) return null;
    return { releases, fresh: Date.now() - timestamp < CACHE_TTL_MS };
  } catch {
    return null; // private mode, blocked storage, corrupt entry — all mean "no cache"
  }
}

export function loadDesktopReleases() {
  if (inflight) return;
  // Stored copy first, so a slow network still paints the right versions
  const stored = readStored();
  if (stored) {
    cache = stored.releases;
    emit();
    if (stored.fresh) return;
  }

  inflight = fetch(GITHUB_RELEASES_API)
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!Array.isArray(data)) return;
      const releases = data.filter(isDesktopRelease).map(toEntry);
      if (!releases.length) return;
      cache = releases;
      emit();
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ releases, timestamp: Date.now() }));
      } catch {}
    })
    .catch(() => {}) // offline or rate-limited — the caller keeps the hand-kept list
    .finally(() => { inflight = null; });
}

function subscribe(listener) {
  listeners.add(listener);
  if (!cache) loadDesktopReleases();
  return () => listeners.delete(listener);
}

/** Every desktop release, newest first — null until loaded, so callers fall back
 * to the hand-kept list in constants instead of rendering an empty page. */
export function useDesktopReleases() {
  return useSyncExternalStore(subscribe, () => cache, () => null);
}

