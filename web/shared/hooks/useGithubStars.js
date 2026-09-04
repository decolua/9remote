"use client";

import { useState, useEffect } from "react";
import { GITHUB_REPO_API } from "@/shared/constants/github";

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
    try {
      const cached = localStorage.getItem(STORAGE_KEY);
      if (cached) {
        const { count, timestamp } = JSON.parse(cached);
        if (typeof count === "number") setStars(count);
        if (Date.now() - timestamp < CACHE_TTL_MS) return;
      }
    } catch {}

    let mounted = true;
    fetch(GITHUB_REPO_API)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!mounted || typeof data?.stargazers_count !== "number") return;
        const count = data.stargazers_count;
        setStars(count);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ count, timestamp: Date.now() }));
        } catch {}
      })
      .catch(() => {});

    return () => {
      mounted = false;
    };
  }, []);

  return { stars, formattedStars: formatStars(stars) };
}
