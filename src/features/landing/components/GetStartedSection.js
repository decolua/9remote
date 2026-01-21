"use client";

import { useState } from "react";

export default function GetStartedSection() {
  const [copied, setCopied] = useState(false);

  const copyCommand = () => {
    navigator.clipboard.writeText("npm install -g 9remote");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section id="get-started" className="relative py-20 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        <div className="bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700 rounded-2xl p-8 sm:p-12 shadow-2xl">
          <div className="text-center mb-8">
            <h2 className="text-3xl sm:text-4xl font-bold mb-4 bg-gradient-to-r from-blue-400 to-blue-500 bg-clip-text text-transparent">
              Get Started in Seconds
            </h2>
            <p className="text-slate-400 text-lg">
              Install 9Remote and start accessing your terminal remotely
            </p>
          </div>

          {/* Terminal mockup */}
          <div className="bg-slate-950 rounded-lg overflow-hidden border border-slate-800 shadow-xl">
            {/* Terminal header */}
            <div className="flex items-center gap-2 px-4 py-3 bg-slate-900 border-b border-slate-800">
              <div className="w-3 h-3 rounded-full bg-red-500" />
              <div className="w-3 h-3 rounded-full bg-yellow-500" />
              <div className="w-3 h-3 rounded-full bg-blue-500" />
              <span className="ml-2 text-xs text-slate-500 font-mono">terminal</span>
            </div>

            {/* Terminal content */}
            <div className="p-6 font-mono text-sm">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-blue-400">$</span>
                <span className="text-slate-300">npm install -g 9remote</span>
                <button
                  onClick={copyCommand}
                  className="ml-auto px-3 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded transition-colors duration-200"
                >
                  {copied ? "✓ Copied" : "Copy"}
                </button>
              </div>

              <div className="text-slate-500 mb-4">
                <div className="mb-1">
                  <span className="text-blue-400">→</span> Installing 9remote...
                </div>
                <div className="mb-1">
                  <span className="text-green-400">✓</span> Installation complete
                </div>
              </div>

              <div className="border-t border-slate-800 pt-4 mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-blue-400">$</span>
                  <span className="text-slate-300">9remote start</span>
                </div>
              </div>

              <div className="text-slate-500">
                <div className="mb-1">
                  <span className="text-blue-400">→</span> Starting server...
                </div>
                <div className="mb-1">
                  <span className="text-blue-400">→</span> Creating tunnel...
                </div>
                <div className="mb-1">
                  <span className="text-green-400">✓</span> Server running on <span className="text-blue-400">http://localhost:3000</span>
                </div>
                <div className="mb-1">
                  <span className="text-green-400">✓</span> Tunnel ready: <span className="text-blue-400">https://xxx.trycloudflare.com</span>
                </div>
                <div className="mt-3 text-orange-400">
                  📱 Scan QR code to connect
                </div>
              </div>
            </div>
          </div>

          {/* Additional info */}
          <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-4 text-center">
            <div className="p-4 bg-slate-900/50 rounded-lg border border-slate-800">
              <div className="text-2xl font-bold text-blue-400 mb-1">30s</div>
              <div className="text-xs text-slate-400">Setup Time</div>
            </div>
            <div className="p-4 bg-slate-900/50 rounded-lg border border-slate-800">
              <div className="text-2xl font-bold text-blue-400 mb-1">0</div>
              <div className="text-xs text-slate-400">Configuration</div>
            </div>
            <div className="p-4 bg-slate-900/50 rounded-lg border border-slate-800">
              <div className="text-2xl font-bold text-blue-400 mb-1">∞</div>
              <div className="text-xs text-slate-400">Possibilities</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
