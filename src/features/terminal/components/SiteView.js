"use client";

export default function SiteView({ port, siteName, onBack }) {
  const proxyUrl = `${window.location.origin}/proxy/${port}/`;

  return (
    <div className="h-[var(--app-height,100vh)] flex flex-col bg-slate-900">
      {/* Header */}
      <div className="bg-slate-800 border-b border-slate-700 px-4 py-3 flex items-center gap-3 flex-shrink-0">
        <button
          onClick={onBack}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium rounded transition"
        >
          ← Back
        </button>
        <div className="flex items-center gap-2">
          <span className="text-green-500">●</span>
          <span className="text-white font-medium">{siteName || `localhost:${port}`}</span>
        </div>
      </div>

      {/* Iframe */}
      <div className="flex-1 min-h-0">
        <iframe
          src={proxyUrl}
          className="w-full h-full border-0"
          title={siteName || `Site on port ${port}`}
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
        />
      </div>
    </div>
  );
}
