"use client";

import { useState } from "react";

export default function SessionList({ sessions, onSelect, onCreate, onDelete, onDisconnect }) {
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
    <div className="h-screen bg-slate-900 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="bg-slate-800 border-b border-slate-700 px-4 sm:px-6 py-4 flex items-center justify-between flex-shrink-0">
        <h1 className="text-white text-lg font-semibold">9Remote Sessions</h1>
        <button
          onClick={onDisconnect}
          className="px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white text-sm font-medium rounded transition"
        >
          Logout
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 p-4 sm:p-6 overflow-auto">
        {/* Create new session */}
        <div className="mb-6 flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            placeholder="Session name (optional)"
            className="flex-1 px-4 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={handleCreate}
            disabled={creating}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 text-white font-medium rounded-lg transition"
          >
            {creating ? "Creating..." : "+ New"}
          </button>
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
                  <button
                    onClick={() => onSelect(session.id)}
                    className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded transition"
                  >
                    Connect
                  </button>
                  <button
                    onClick={() => onDelete(session.id)}
                    className="px-3 py-1.5 bg-slate-700 hover:bg-red-600 text-white text-sm font-medium rounded transition"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
