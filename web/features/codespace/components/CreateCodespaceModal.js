"use client";

import { useEffect, useState, useMemo } from "react";
import Button from "@/shared/components/ui/Button";
import Spinner from "@/shared/components/ui/Spinner";
import { X, Search, AlertCircle, Plus } from "@/shared/components/ui/Icon";
import { useGithub } from "../hooks/useGithub";

export default function CreateCodespaceModal({ isOpen, onClose, onCreated }) {
  const { listRepos, createCodespace, ensureDevcontainer, setApiKeySecret, generateApiKey, error } = useGithub();
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(null);
  const [query, setQuery] = useState("");
  const [localErr, setLocalErr] = useState(null);
  const [progressMsg, setProgressMsg] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    setLocalErr(null);
    setLoading(true);
    listRepos()
      .then((data) => setRepos(Array.isArray(data) ? data : []))
      .catch((e) => setLocalErr(e.message))
      .finally(() => setLoading(false));
  }, [isOpen, listRepos]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter((r) => r.full_name.toLowerCase().includes(q));
  }, [repos, query]);

  const handleCreate = async (repo) => {
    setCreating(repo.full_name);
    setLocalErr(null);
    setProgressMsg("Generating API key...");
    try {
      const apiKey = generateApiKey();
      setProgressMsg("Setting codespace secret...");
      await setApiKeySecret(repo.id, apiKey);
      setProgressMsg("Setting up devcontainer...");
      await ensureDevcontainer(repo.owner.login, repo.name);
      setProgressMsg("Creating codespace...");
      const cs = await createCodespace(repo.owner.login, repo.name);
      onCreated({ codespace: cs, apiKey });
    } catch (e) {
      setLocalErr(e.message);
    } finally {
      setCreating(null);
      setProgressMsg("");
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card-elev p-6 max-w-md w-full max-h-[80dvh] flex flex-col border border-border" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-text">Select repository</h3>
          <button onClick={onClose} className="p-1 text-text-muted hover:text-text">
            <X size={20} />
          </button>
        </div>

        <div className="relative mb-3">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search repos..."
            className="w-full pl-9 pr-3 py-2 bg-surface-2 rounded-brand text-text placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/40 text-sm"
          />
        </div>

        {(localErr || error) && (
          <div className="flex items-start gap-2 mb-3 p-2 bg-danger/10 rounded-brand text-xs text-danger">
            <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
            <span className="break-words">{localErr || error}</span>
          </div>
        )}

        <div className="flex-1 overflow-auto space-y-1">
          {loading ? (
            <Spinner text="Loading repos..." />
          ) : filtered.length === 0 ? (
            <div className="text-center py-6 text-text-muted text-sm">No repos</div>
          ) : (
            filtered.map((repo) => {
              const busy = creating === repo.full_name;
              return (
                <div key={repo.id} className="p-2 bg-surface-2 hover:bg-surface-3 rounded-brand transition-colors">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-text font-medium truncate" title={repo.full_name}>{repo.full_name}</div>
                      {repo.private && <span className="text-xs text-text-muted">private</span>}
                    </div>
                    <Button
                      variant="primary"
                      onClick={() => handleCreate(repo)}
                      disabled={!!creating}
                      loading={busy}
                      className="!py-1 !px-2 text-xs"
                    >
                      <Plus size={12} />
                      Create
                    </Button>
                  </div>
                  {busy && progressMsg && <div className="mt-1 text-xs text-text-muted">{progressMsg}</div>}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
