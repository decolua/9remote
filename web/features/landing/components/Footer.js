"use client";

import Link from "next/link";

export default function Footer() {
  const version = process.env.NEXT_PUBLIC_SERVER_VERSION;

  return (
    <footer className="relative border-t border-gray-200 bg-gray-50/50 backdrop-blur-sm py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
          {/* Brand */}
          <div className="col-span-1 md:col-span-2">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center">
                <span className="text-xl font-bold text-white">9</span>
              </div>
              <h3 className="text-xl font-bold text-gray-900">9Remote</h3>
            </div>
            <p className="text-gray-600 text-sm max-w-md mb-4">
              Secure remote terminal and desktop access. Connect to your machines from anywhere in the world.
            </p>
            <p className="text-gray-500 text-xs">
              © {new Date().getFullYear()} 9Remote. All rights reserved.
              {version && <span className="ml-2 text-gray-400">v{version}</span>}
            </p>
          </div>

          {/* Product */}
          <div>
            <h4 className="text-gray-900 font-semibold mb-4">Product</h4>
            <ul className="space-y-2">
              <li>
                <Link href="/login" className="text-gray-600 hover:text-orange-400 text-sm transition-colors">
                  Remote
                </Link>
              </li>
              <li>
                <Link href="/workspace" className="text-gray-600 hover:text-orange-400 text-sm transition-colors">
                  Terminal
                </Link>
              </li>
              <li>
                <Link href="/remote" className="text-gray-600 hover:text-orange-400 text-sm transition-colors">
                  Remote Desktop
                </Link>
              </li>
            </ul>
          </div>

          {/* Resources */}
          <div>
            <h4 className="text-gray-900 font-semibold mb-4">Resources</h4>
            <ul className="space-y-2">
              <li>
                <a 
                  href="https://github.com/decolua/9remote" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-gray-600 hover:text-orange-400 text-sm transition-colors"
                >
                  GitHub
                </a>
              </li>
              <li>
                <a 
                  href="https://www.npmjs.com/package/9remote" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-gray-600 hover:text-orange-400 text-sm transition-colors"
                >
                  NPM
                </a>
              </li>
              <li>
                <a 
                  href="https://github.com/decolua/9remote#readme" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-gray-600 hover:text-orange-400 text-sm transition-colors"
                >
                  Documentation
                </a>
              </li>
              <li>
                <a 
                  href="https://www.facebook.com/groups/9teamvn" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-gray-600 hover:text-orange-400 text-sm transition-colors"
                >
                  Facebook
                </a>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="pt-8 border-t border-gray-200 flex flex-col sm:flex-row justify-between items-center gap-4">
          <p className="text-gray-500 text-xs">
            Built with Next.js, Socket.io, and Cloudflare Workers
          </p>
          <div className="flex gap-6">
            <a 
              href="https://github.com/decolua/9remote" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-gray-500 hover:text-orange-400 text-xs transition-colors"
            >
              GitHub
            </a>
            <a 
              href="https://www.npmjs.com/package/9remote" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-gray-500 hover:text-orange-400 text-xs transition-colors"
            >
              NPM
            </a>
            <a 
              href="https://www.facebook.com/groups/9teamvn" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-gray-500 hover:text-orange-400 text-xs transition-colors"
            >
              Facebook
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
