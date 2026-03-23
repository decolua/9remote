"use client";

import Link from "next/link";

export default function HeroSection() {
  return (
    <section className="relative min-h-screen flex items-center justify-center px-4 sm:px-6 lg:px-8 pt-20">
      {/* Glow effect */}
      {/* <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-brand-500/5 rounded-full blur-[120px] pointer-events-none" /> */}
      
      <div className="max-w-6xl mx-auto text-center relative z-10">
        {/* Version badge */}
        <div className="inline-flex items-center gap-2 px-4 py-2 mb-8 rounded-full border border-brand-500/30 bg-brand-500/10 backdrop-blur-sm animate-fade-in">
          <span className="w-2 h-2 rounded-full bg-brand-500 animate-pulse" />
          <span className="text-sm text-brand-500 font-medium">v1.0 Now Available</span>
        </div>

        {/* Main heading */}
        <h1 className="text-3xl sm:text-4xl lg:text-5xl xl:text-6xl mb-6 animate-fade-in-delay-1" style={{ fontWeight: 900 }}>
          <span className="block text-gray-900 mb-4">Want to code from bed?</span>
          <span className="block text-gray-900 mb-4">Fix bugs while having coffee?</span>
          <span className="block bg-gradient-to-r from-brand-500 to-brand-500 bg-clip-text text-transparent">
            Deploy while on vacation?
          </span>
        </h1>

        <p className="text-base text-gray-600 mb-12 max-w-2xl mx-auto animate-fade-in-delay-3">
          Just need your phone. Terminal always in your pocket. Work from anywhere.
        </p>

        {/* CTA Buttons */}
        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center mb-16 animate-fade-in-delay-4">
          <Link 
            href="/login"
            className="group relative px-8 py-4 bg-gradient-to-r from-brand-500 to-brand-500 rounded-lg font-bold text-white shadow-lg shadow-brand-500/40 hover:shadow-brand-500/60 transition-all duration-300 hover:scale-105 w-full sm:w-auto overflow-hidden"
          >
            <span className="relative z-10 flex items-center justify-center gap-2">
              <span>Login</span>
              <svg className="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </span>
            <div className="absolute inset-0 rounded-lg bg-gradient-to-r from-brand-500 to-brand-600 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
          </Link>

          <Link 
            href="/workspace"
            className="group px-8 py-4 bg-white backdrop-blur-sm border border-gray-300 rounded-lg font-bold text-gray-900 hover:bg-gray-50 hover:border-brand-500/50 transition-all duration-300 hover:scale-105 w-full sm:w-auto"
          >
            <span className="flex items-center justify-center gap-2">
              <span>View Demo</span>
              <svg className="w-5 h-5 group-hover:scale-110 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </span>
          </Link>
        </div>

        {/* Install commands */}
        <div className="max-w-3xl mx-auto animate-fade-in-delay-5">
          <div className="p-6 bg-gray-50 backdrop-blur-sm border border-gray-200 rounded-xl shadow-2xl">
            <div className="flex items-center gap-2 mb-4">
              <div className="flex gap-2">
                <div className="w-3 h-3 rounded-full bg-red-500" />
                <div className="w-3 h-3 rounded-full bg-yellow-500" />
                <div className="w-3 h-3 rounded-full bg-brand-500" />
              </div>
              <span className="text-xs text-gray-500 ml-2">terminal</span>
            </div>
            
            <div className="space-y-3 font-mono text-sm">
              <div className="flex items-center gap-2">
                <span className="text-brand-500">$</span>
                <code className="text-gray-900">npm install -g 9remote</code>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-brand-500">$</span>
                <code className="text-gray-900">9remote start</code>
              </div>
              <div className="text-gray-600 text-xs mt-3 flex items-center gap-2">
                <svg className="w-4 h-4 text-brand-500" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                <span>Ready in 30 seconds</span>
              </div>
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-8 max-w-2xl mx-auto mt-16 animate-fade-in-delay-6">
          <div className="text-center">
            <div className="text-3xl font-bold text-brand-500 mb-1">100%</div>
            <div className="text-sm text-gray-600">Secure</div>
          </div>
          <div className="text-center">
            <div className="text-3xl font-bold text-brand-500 mb-1">&lt;50ms</div>
            <div className="text-sm text-gray-600">Latency</div>
          </div>
          <div className="text-center">
            <div className="text-3xl font-bold text-brand-500 mb-1">24/7</div>
            <div className="text-sm text-gray-600">Available</div>
          </div>
        </div>
      </div>

      {/* CSS for fade-in animations */}
      <style jsx>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .animate-fade-in {
          animation: fadeIn 0.8s ease-out forwards;
        }

        .animate-fade-in-delay-1 {
          opacity: 0;
          animation: fadeIn 0.8s ease-out 0.1s forwards;
        }

        .animate-fade-in-delay-2 {
          opacity: 0;
          animation: fadeIn 0.8s ease-out 0.2s forwards;
        }

        .animate-fade-in-delay-3 {
          opacity: 0;
          animation: fadeIn 0.8s ease-out 0.3s forwards;
        }

        .animate-fade-in-delay-4 {
          opacity: 0;
          animation: fadeIn 0.8s ease-out 0.4s forwards;
        }

        .animate-fade-in-delay-5 {
          opacity: 0;
          animation: fadeIn 0.8s ease-out 0.5s forwards;
        }

        .animate-fade-in-delay-6 {
          opacity: 0;
          animation: fadeIn 0.8s ease-out 0.6s forwards;
        }
      `}</style>
    </section>
  );
}
