"use client";

import { useState } from "react";
import Button from "@/shared/components/ui/Button";
import { Github, ExternalLink, Eye, EyeOff, X, AlertCircle } from "@/shared/components/ui/Icon";
import { useGithub } from "../hooks/useGithub";
import { GITHUB_PAT_GENERATE_URL } from "@/shared/constants/github";

export default function GithubLoginForm({ onAuthenticated }) {
  const { setToken, getUser } = useGithub();
  const [pat, setPat] = useState("");
  const [showPat, setShowPat] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [err, setErr] = useState(null);

  const handleConnect = async () => {
    const trimmed = pat.trim();
    if (!trimmed) return;
    setVerifying(true);
    setErr(null);
    try {
      // Verify by calling /user with the new token
      const user = await getUserWithToken(trimmed);
      setToken(trimmed);
      onAuthenticated(user);
    } catch (e) {
      setErr(e.message || "Invalid token");
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="space-y-4">
      <a
        href={GITHUB_PAT_GENERATE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center gap-2 w-full py-2.5 px-3 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-colors text-sm"
      >
        <Github size={16} />
        Generate token on GitHub
        <ExternalLink size={14} />
      </a>

      <div>
        <label className="block text-sm font-medium text-text mb-2">Personal Access Token</label>
        <div className="relative">
          <input
            type={showPat ? "text" : "password"}
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && pat && handleConnect()}
            placeholder="ghp_... or github_pat_..."
            className="w-full px-4 py-3 pr-20 bg-surface-2 rounded-brand text-text placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/40"
          />
          {pat && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => setShowPat(!showPat)} className="text-text-muted hover:text-text" type="button">
                {showPat ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => setPat("")} className="text-text-muted hover:text-text" type="button">
                <X size={20} />
              </button>
            </div>
          )}
        </div>
        {err && (
          <div className="flex items-start gap-2 mt-2 text-sm text-danger">
            <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
            <span className="break-words">{err}</span>
          </div>
        )}
      </div>

      <Button variant="primary" onClick={handleConnect} disabled={!pat || verifying} loading={verifying} className="w-full">
        Continue
      </Button>
    </div>
  );
}

async function getUserWithToken(token) {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json"
    }
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  return res.json();
}
