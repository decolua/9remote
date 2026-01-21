"use client";

import Link from "next/link";

export default function Footer() {
  return (
    <footer className="relative border-t border-slate-800 bg-slate-950/50 backdrop-blur-sm py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
          {/* Brand */}
          <div className="col-span-1 md:col-span-2">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center">
                <span className="text-xl font-bold text-white">9</span>
              </div>
              <h3 className="text-xl font-bold text-white">9Remote</h3>
            </div>
            <p className="text-slate-400 text-sm max-w-md mb-4">
              Secure remote terminal and desktop access. Connect to your machines from anywhere in the world.
            </p>
            <p className="text-slate-500 text-xs">
              © {new Date().getFullYear()} 9Remote. All rights reserved.
            </p>
          </div>

          {/* Product */}
          <div>
            <h4 className="text-white font-semibold mb-4">Product</h4>
            <ul className="space-y-2">
              <li>
                <Link href="/login" className="text-slate-400 hover:text-blue-400 text-sm transition-colors">
                  Login
                </Link>
              </li>
              <li>
                <Link href="/terminal" className="text-slate-400 hover:text-blue-400 text-sm transition-colors">
                  Terminal
                </Link>
              </li>
              <li>
                <Link href="/remote" className="text-slate-400 hover:text-blue-400 text-sm transition-colors">
                  Remote Desktop
                </Link>
              </li>
            </ul>
          </div>

          {/* Resources */}
          <div>
            <h4 className="text-white font-semibold mb-4">Resources</h4>
            <ul className="space-y-2">
              <li>
                <a 
                  href="https://github.com/decolua/9remote" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-slate-400 hover:text-blue-400 text-sm transition-colors"
                >
                  GitHub
                </a>
              </li>
              <li>
                <a 
                  href="https://www.npmjs.com/package/9remote" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-slate-400 hover:text-blue-400 text-sm transition-colors"
                >
                  NPM
                </a>
              </li>
              <li>
                <a 
                  href="https://github.com/decolua/9remote#readme" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-slate-400 hover:text-blue-400 text-sm transition-colors"
                >
                  Documentation
                </a>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="pt-8 border-t border-slate-800 flex flex-col sm:flex-row justify-between items-center gap-4">
          <p className="text-slate-500 text-xs">
            Built with Next.js, Socket.io, and Cloudflare Workers
          </p>
          <div className="flex gap-6">
            <a 
              href="https://github.com/decolua/9remote" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-slate-500 hover:text-blue-400 text-xs transition-colors"
            >
              GitHub
            </a>
            <a 
              href="https://www.npmjs.com/package/9remote" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-slate-500 hover:text-blue-400 text-xs transition-colors"
            >
              NPM
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
