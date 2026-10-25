"use client";

import { useState, useEffect } from "react";
import { GITHUB_REPO_API, SHOW_GITHUB_STAR } from "@/shared/constants/github";
import { AREMOTE } from "@/shared/aremote/client";

const STORAGE_KEY = "9remote_github_stars";
const CACHE_TTL_MS = 60 * 60 * 1000;

function formatStars(count) {
  if (count == null) return "";
  if (count >= 1000) return (count / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(count);
}

export function useGithubStars() {
  const [stars, setStars] = useState(null);

  useEffect(() => {
    if (AREMOTE || !SHOW_GITHUB_STAR) return;
    let mounted = true;
    async function load() {
      await Promise.resolve();
      if (!mounted) return;
      try {
        const cached = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
        if (typeof cached?.count === "number") {
          setStars(cached.count);
          if (Date.now() - cached.timestamp < CACHE_TTL_MS) return;
        }
      } catch {}
      try {
        const res = await fetch(GITHUB_REPO_API);
        const data = res.ok ? await res.json() : null;
        if (!mounted || typeof data?.stargazers_count !== "number") return;
        const count = data.stargazers_count;
        setStars(count);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ count, timestamp: Date.now() }));
        } catch {}
      } catch {}
    }
    load();

    return () => {
      mounted = false;
    };
  }, []);

  return { stars, formattedStars: formatStars(stars) };
}
