"use client";

import { useState } from "react";
import Button from "@/shared/components/ui/Button";
import Input from "@/shared/components/ui/Input";
import SitesList from "@/features/terminal/components/SitesList";

export default function SessionList({ sessions, onSelect, onCreate, onDelete, onDisconnect, onOpenRemote, onSelectSite, tunnelUrl }) {
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    await onCreate(newName || `Terminal ${sessions.length + 1}`);
    setNewName("");
    setCreating(false);
  };

  return (
    <div className="h-full bg-slate-900 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="bg-slate-800 border-b border-slate-700 px-4 sm:px-6 py-4 flex items-center justify-between flex-shrink-0">
        <h1 className="text-white text-lg font-semibold">9Remote Sessions</h1>
        
        <div className="flex items-center gap-2">
          {/* Remote Desktop Button */}
          <button
            onClick={onOpenRemote}
            className="px-3 sm:px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded transition flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            <span className="hidden sm:inline">Remote</span>
          </button>

          {/* Sites Button */}
          <SitesList tunnelUrl={tunnelUrl} onSelectSite={onSelectSite} />

          {/* Logout Button */}
          <Button
            variant="danger"
            size="sm"
            onClick={onDisconnect}
          >
            Logout
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 p-4 sm:p-6 overflow-auto">
        {/* Create new session */}
        <div className="mb-6 flex gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            placeholder="Session name (optional)"
          />
          <Button
            variant="primary"
            onClick={handleCreate}
            disabled={creating}
            loading={creating}
            className="whitespace-nowrap"
          >
            + New
          </Button>
        </div>

        {/* Sessions list */}
        {sessions.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-slate-400 mb-4">No active sessions</p>
            <p className="text-slate-500 text-sm">Create a new session to get started</p>
          </div>
        ) : (
          <div className="space-y-3">
            {sessions.map((session) => (
              <div
                key={session.id}
                className="bg-slate-800 border border-slate-700 rounded-lg p-4 flex items-center justify-between hover:border-slate-600 transition"
              >
                <div 
                  className="flex-1 cursor-pointer"
                  onClick={() => onSelect(session.id)}
                >
                  <h3 className="text-white font-medium">{session.name}</h3>
                  <p className="text-slate-400 text-sm">
                    Created {new Date(session.createdAt).toLocaleTimeString()}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="success"
                    size="sm"
                    onClick={() => onSelect(session.id)}
                  >
                    Connect
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onDelete(session.id)}
                    className="hover:bg-red-600"
                  >
                    ✕
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
