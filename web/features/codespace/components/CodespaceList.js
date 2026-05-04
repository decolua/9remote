"use client";

import { useEffect, useState, useCallback } from "react";
import Button from "@/shared/components/ui/Button";
import Spinner from "@/shared/components/ui/Spinner";
import { Github, RefreshCw, Play, LogOut, AlertCircle, Plus } from "@/shared/components/ui/Icon";
import { useGithub } from "../hooks/useGithub";
import { CODESPACE_STATE } from "@/shared/constants/github";
import CreateCodespaceModal from "./CreateCodespaceModal";
import { saveCodespaceKey, getCodespaceKey } from "../lib/codespaceKeyStorage";

export default function CodespaceList({ onConnect, onLogout }) {
  const { listCodespaces, startCodespace, waitUntilAvailable, loading, error, getUser } = useGithub();
  const [codespaces, setCodespaces] = useState([]);
  const [user, setUser] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [progressMsg, setProgressMsg] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const u = await getUser();
      setUser(u);
    } catch {}
    const list = await listCodespaces();
    setCodespaces(list);
  }, [getUser, listCodespaces]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleConnect = async (cs) => {
    const apiKey = getCodespaceKey(cs.name);
    if (!apiKey) {
      setProgressMsg("No saved key for this codespace. Recreate it from web to enable auto-connect.");
      setBusyId(cs.name);
      setTimeout(() => { setBusyId(null); setProgressMsg(""); }, 4000);
      return;
    }
    setBusyId(cs.name);
    setProgressMsg("");
    try {
      let target = cs;
      if (cs.state !== CODESPACE_STATE.available) {
        setProgressMsg("Starting codespace...");
        await startCodespace(cs.name);
        target = await waitUntilAvailable(cs.name, (state) => {
          setProgressMsg(`State: ${state}`);
        });
      }
      onConnect(target, apiKey);
    } catch (e) {
      setProgressMsg(`Error: ${e.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleCreated = ({ codespace, apiKey }) => {
    saveCodespaceKey(codespace.name, apiKey);
    setCreateOpen(false);
    refresh();
  };

  return (
    <div className="card-elev p-8 max-w-md w-full border border-border">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-brand-500/10 rounded-brand">
          <Github className="text-brand-500" size={24} />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-bold text-text">Codespaces</h2>
          {user && <p className="text-sm text-text-muted truncate">@{user.login}</p>}
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors"
          title="New codespace"
        >
          <Plus size={18} />
        </button>
        <button
          onClick={refresh}
          disabled={loading}
          className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors"
          title="Refresh"
        >
          <RefreshCw size={18} className={loading ? "animate-spin" : ""} />
        </button>
        <button
          onClick={onLogout}
          className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors"
          title="Logout"
        >
          <LogOut size={18} />
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 mb-4 p-3 bg-danger/10 rounded-brand text-sm text-danger">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <span className="break-words">{error}</span>
        </div>
      )}

      {loading && codespaces.length === 0 ? (
        <Spinner text="Loading codespaces..." />
      ) : codespaces.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-text-muted text-sm mb-4">No codespaces yet.</p>
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus size={16} />
            Create new codespace
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {codespaces.map((cs) => {
            const isBusy = busyId === cs.name;
            const isAvailable = cs.state === CODESPACE_STATE.available;
            return (
              <div key={cs.name} className="bg-surface-2 rounded-brand p-3 hover:bg-surface-3 transition-colors">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-text font-medium truncate">{cs.display_name || cs.name}</div>
                    <div className="text-xs text-text-muted truncate">
                      {cs.repository?.full_name} · {cs.state}
                    </div>
                  </div>
                  <Button
                    variant="primary"
                    onClick={() => handleConnect(cs)}
                    disabled={isBusy}
                    loading={isBusy}
                    className="!py-1.5 !px-3 text-sm"
                  >
                    <Play size={14} />
                    {isAvailable ? "Connect" : "Start"}
                  </Button>
                </div>
                {isBusy && progressMsg && (
                  <div className="mt-2 text-xs text-text-muted">{progressMsg}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <CreateCodespaceModal
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
    </div>
  );
}
