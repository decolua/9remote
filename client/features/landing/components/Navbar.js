"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 20);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? "bg-white/80 backdrop-blur-lg border-b border-gray-200 shadow-lg"
          : "bg-transparent"
      }`}
    >
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-3 group">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#E68A6E] to-[#E68A6E] flex items-center justify-center font-bold text-lg shadow-lg shadow-[#E68A6E]/20 group-hover:shadow-[#E68A6E]/40 transition-shadow text-white">
            9
          </div>
          <span className="text-xl font-bold tracking-tight">9Remote</span>
        </Link>

        {/* Desktop Menu */}
        <div className="hidden md:flex items-center gap-8">
          <a
            href="#features"
            className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
          >
            Features
          </a>
          <a
            href="#terminal-demo"
            className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
          >
            How it Works
          </a>
          <a
            href="#get-started"
            className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
          >
            Get Started
          </a>
          <a
            href="https://github.com/decolua/9remote"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-gray-600 hover:text-gray-900 transition-colors flex items-center gap-1"
          >
            GitHub
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>

        {/* CTA Button */}
        <div className="hidden md:flex items-center gap-4">
          <Link
            href="/login"
            className="px-6 py-2 rounded-lg bg-[#E68A6E] hover:bg-[#E68A6E]/90 text-white font-semibold text-sm shadow-lg shadow-[#E68A6E]/20 hover:shadow-[#E68A6E]/40 transition-all"
          >
            Login
          </Link>
        </div>

        {/* Mobile Menu Button */}
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="md:hidden p-2 text-gray-600 hover:text-gray-900"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            {mobileMenuOpen ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            )}
          </svg>
        </button>
      </div>

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div className="md:hidden bg-white/95 backdrop-blur-lg border-t border-gray-200">
          <div className="flex flex-col gap-4 p-6">
            <a
              href="#features"
              onClick={() => setMobileMenuOpen(false)}
              className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
            >
              Features
            </a>
            <a
              href="#terminal-demo"
              onClick={() => setMobileMenuOpen(false)}
              className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
            >
              How it Works
            </a>
            <a
              href="#get-started"
              onClick={() => setMobileMenuOpen(false)}
              className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
            >
              Get Started
            </a>
            <a
              href="https://github.com/decolua/9remote"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
            >
              GitHub
            </a>
            <Link
              href="/login"
              className="px-6 py-2 rounded-lg bg-[#E68A6E] hover:bg-[#E68A6E]/90 text-white font-semibold text-sm text-center"
            >
              Login
            </Link>
          </div>
        </div>
      )}
    </nav>
  );
}
