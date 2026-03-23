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
        <div className="bg-gradient-to-br from-gray-50 to-white border border-gray-200 rounded-2xl p-8 sm:p-12 shadow-2xl">
          <div className="text-center mb-8">
            <h2 className="text-3xl sm:text-4xl font-bold mb-4 text-gray-900">
              Get Started in Seconds
            </h2>
            <p className="text-gray-600 text-lg">
              Install 9Remote and start accessing your terminal remotely
            </p>
          </div>

          {/* Terminal mockup */}
          <div className="bg-white rounded-lg overflow-hidden border border-gray-200 shadow-xl">
            {/* Terminal header */}
            <div className="flex items-center gap-2 px-4 py-3 bg-gray-100 border-b border-gray-200">
              <div className="w-3 h-3 rounded-full bg-red-500" />
              <div className="w-3 h-3 rounded-full bg-yellow-500" />
              <div className="w-3 h-3 rounded-full bg-brand-500" />
              <span className="ml-2 text-xs text-gray-600 font-mono">terminal</span>
            </div>

            {/* Terminal content */}
            <div className="p-6 font-mono text-sm">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-brand-500">$</span>
                <span className="text-gray-900">npm install -g 9remote</span>
                <button
                  onClick={copyCommand}
                  className="ml-auto px-3 py-1 text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 rounded transition-colors duration-200"
                >
                  {copied ? "✓ Copied" : "Copy"}
                </button>
              </div>

              <div className="text-gray-600 mb-4">
                <div className="mb-1">
                  <span className="text-brand-500">→</span> Installing 9remote...
                </div>
                <div className="mb-1">
                  <span className="text-green-400">✓</span> Installation complete
                </div>
              </div>

              <div className="border-t border-gray-200 pt-4 mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-brand-500">$</span>
                  <span className="text-gray-900">9remote start</span>
                </div>
              </div>

              <div className="text-gray-600">
                <div className="mb-1">
                  <span className="text-brand-500">→</span> Starting server...
                </div>
                <div className="mb-1">
                  <span className="text-brand-500">→</span> Creating tunnel...
                </div>
                <div className="mb-1">
                  <span className="text-green-400">✓</span> Server running on <span className="text-brand-500">http://localhost:3000</span>
                </div>
                <div className="mb-1">
                  <span className="text-green-400">✓</span> Tunnel ready: <span className="text-brand-500">https://xxx.trycloudflare.com</span>
                </div>
                <div className="mt-3 text-brand-500 flex items-center gap-2">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 12h2a1 1 0 001-1v-2a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zM17 8h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1z" />
                  </svg>
                  Scan QR code to connect
                </div>
              </div>
            </div>
          </div>

          {/* Additional info */}
          <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-4 text-center">
            <div className="p-4 bg-white rounded-lg border border-gray-200">
              <div className="text-2xl font-bold text-brand-500 mb-1">30s</div>
              <div className="text-xs text-gray-600">Setup Time</div>
            </div>
            <div className="p-4 bg-white rounded-lg border border-gray-200">
              <div className="text-2xl font-bold text-brand-500 mb-1">0</div>
              <div className="text-xs text-gray-600">Configuration</div>
            </div>
            <div className="p-4 bg-white rounded-lg border border-gray-200">
              <div className="text-2xl font-bold text-brand-500 mb-1">∞</div>
              <div className="text-xs text-gray-600">Possibilities</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
