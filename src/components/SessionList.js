"use client";

import { useState } from "react";
import Button from "./ui/Button";
import Input from "./ui/Input";

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
    <div className="h-full bg-slate-900 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="bg-slate-800 border-b border-slate-700 px-4 sm:px-6 py-4 flex items-center justify-between flex-shrink-0">
        <h1 className="text-white text-lg font-semibold">9Remote Sessions</h1>
        <Button
          variant="danger"
          size="sm"
          onClick={onDisconnect}
        >
          Logout
        </Button>
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
