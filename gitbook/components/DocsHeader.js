"use client";

import { useState } from "react";
import Link from "next/link";
import { DOCS_CONFIG } from "@/constants/docsConfig";
import { Search, ExternalLink, Menu, X } from "lucide-react";
import DocsSidebar from "./DocsSidebar";

export default function DocsHeader() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <>
      <header className="sticky top-0 z-50 w-full border-b bg-white/80 backdrop-blur-sm border-gray-200">
        <div className=" mx-auto px-4 h-16 flex items-center justify-between">
          {/* Mobile menu button */}
          <button
            onClick={() => setMobileMenuOpen(true)}
            className="lg:hidden p-2 rounded-lg hover:bg-gray-100 transition-colors"
            aria-label="Open menu"
          >
            <Menu className="w-6 h-6 text-gray-600" />
          </button>

          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 font-bold text-2xl text-black hover:opacity-80 transition-opacity">
            <span>9</span>
            <span className="text-[#E68A6E]">Remote Docs</span>
          </Link>

          {/* Right side */}
          <div className="flex items-center gap-2 sm:gap-4">
            {/* Search (placeholder) */}
            <button className="hidden md:flex items-center gap-2 px-3 py-1.5 text-sm text-gray-500 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
              <Search className="w-4 h-4" />
              <span className="hidden sm:inline">Search...</span>
              <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-xs bg-white border border-gray-300 rounded">⌘K</kbd>
            </button>

            {/* Go to App */}
            <Link
              href={DOCS_CONFIG.appUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-[#E68A6E] text-white rounded-lg font-medium hover:bg-[#d67a5e] transition-colors text-sm"
            >
              <span className="hidden sm:inline">Go to App</span>
              <ExternalLink className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </header>

      {/* Mobile menu */}
      {mobileMenuOpen && (
        <>
          {/* Overlay */}
          <div
            className="mobile-menu-overlay lg:hidden"
            onClick={() => setMobileMenuOpen(false)}
          />
          
          {/* Drawer */}
          <div className="mobile-menu-drawer lg:hidden">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <span className="font-bold text-lg text-black">
                <span className="text-[#E68A6E]">9</span>Remote Docs
              </span>
              <button
                onClick={() => setMobileMenuOpen(false)}
                className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
                aria-label="Close menu"
              >
                <X className="w-5 h-5 text-gray-600" />
              </button>
            </div>
            <DocsSidebar isMobile onClose={() => setMobileMenuOpen(false)} />
          </div>
        </>
      )}
    </>
  );
}
