"use client";

import Link from "next/link";

export default function HeroSection() {
  return (
    <section className="relative min-h-screen flex items-center justify-center px-4 sm:px-6 lg:px-8 pt-20 overflow-hidden">
      {/* Colorful linear gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-blue-100 via-purple-50 to-pink-100" />
      
      {/* Grid pattern overlay */}
      <div className="absolute inset-0 bg-grid-pattern opacity-[0.02]" />
      
      <div className="max-w-7xl mx-auto relative z-10 w-full">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          {/* Left: Content */}
          <div className="text-center lg:text-left">
            {/* Version badge */}
            <div className="inline-flex items-center gap-2 px-4 py-2 mb-6 rounded-full border border-brand-500/30 bg-white/80 backdrop-blur-sm animate-fade-in shadow-sm">
              <span className="w-2 h-2 rounded-full bg-brand-500 animate-pulse" />
              <span className="text-sm text-brand-500 font-medium">v{process.env.NEXT_PUBLIC_SERVER_VERSION} Now Available</span>
            </div>

            {/* Main heading - smaller */}
            <h1 className="text-xl sm:text-2xl lg:text-3xl xl:text-4xl mb-4 animate-fade-in-delay-1" style={{ fontWeight: 900 }}>
              <span className="block text-gray-900 mb-2">Want to code from bed?</span>
              <span className="block text-gray-900 mb-2">Fix bugs while having coffee?</span>
              <span className="block bg-gradient-to-r from-brand-500 to-purple-600 bg-clip-text text-transparent">
                Deploy while on vacation?
              </span>
            </h1>

            <p className="text-sm sm:text-base text-gray-600 mb-8 max-w-xl mx-auto lg:mx-0 animate-fade-in-delay-3">
              Just need your phone. Terminal always in your pocket. Work from anywhere.
            </p>

            {/* CTA Buttons */}
            <div className="flex flex-col sm:flex-row gap-4 justify-center lg:justify-start items-center mb-10 animate-fade-in-delay-4">
              <Link 
                href="/login"
                className="group relative px-6 py-3 bg-gradient-to-r from-brand-500 to-brand-600 rounded-lg font-bold text-white shadow-lg shadow-brand-500/40 hover:shadow-brand-500/60 transition-all duration-300 hover:scale-105 w-full sm:w-auto overflow-hidden"
              >
                <span className="relative z-10 flex items-center justify-center gap-2">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                  </svg>
                  <span>Login</span>
                  <svg className="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                  </svg>
                </span>
              </Link>

              <Link 
                href="https://docs.9remote.cc/"
                target="_blank"
                rel="noopener noreferrer"
                className="group px-6 py-3 bg-white/80 backdrop-blur-sm border border-gray-300 rounded-lg font-bold text-gray-900 hover:bg-white hover:border-brand-500/50 transition-all duration-300 hover:scale-105 w-full sm:w-auto shadow-sm"
              >
                <span className="flex items-center justify-center gap-2">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <span>Documentation</span>
                  <svg className="w-4 h-4 group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </span>
              </Link>
            </div>

            {/* Install commands */}
            <div className="max-w-xl mx-auto lg:mx-0 animate-fade-in-delay-5">
              <div className="p-4 bg-gray-900/95 backdrop-blur-sm border border-gray-700 rounded-xl shadow-lg">
                <div className="flex items-center gap-2 mb-3">
                  <div className="flex gap-2">
                    <div className="w-3 h-3 rounded-full bg-red-500" />
                    <div className="w-3 h-3 rounded-full bg-yellow-500" />
                    <div className="w-3 h-3 rounded-full bg-green-500" />
                  </div>
                  <span className="text-xs text-gray-400 ml-2">terminal</span>
                </div>
                
                <div className="space-y-2 font-mono text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-green-400">$</span>
                    <code className="text-gray-100">npm install -g 9remote</code>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-green-400">$</span>
                    <code className="text-gray-100">9remote</code>
                  </div>
                  <div className="text-gray-400 text-xs mt-2 flex items-center gap-2">
                    <svg className="w-4 h-4 text-green-400" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    <span>Ready in 30 seconds</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-6 max-w-md mx-auto lg:mx-0 mt-10 animate-fade-in-delay-6">
              <div className="text-center lg:text-left">
                <div className="text-2xl font-bold text-brand-500 mb-1">100%</div>
                <div className="text-xs text-gray-600">Secure</div>
              </div>
              <div className="text-center lg:text-left">
                <div className="text-2xl font-bold text-brand-500 mb-1">&lt;50ms</div>
                <div className="text-xs text-gray-600">Latency</div>
              </div>
              <div className="text-center lg:text-left">
                <div className="text-2xl font-bold text-brand-500 mb-1">24/7</div>
                <div className="text-xs text-gray-600">Available</div>
              </div>
            </div>
          </div>

          {/* Right: Mobile mockup */}
          <div className="hidden lg:flex justify-center items-center animate-fade-in-delay-2" style={{ perspective: "1200px" }}>
            <div className="relative animate-float-phone">
              {/* Phone mockup with tilt */}
              <div className="relative transition-transform duration-300 hover:scale-105" style={{ transform: "rotateY(-15deg) rotateX(20deg) rotate(8deg)" }}>
                {/* Phone frame */}
                <div className="relative w-[280px] h-[580px] bg-gray-900 rounded-[3rem] p-3 shadow-2xl">
                  {/* Screen */}
                  <div className="w-full h-full bg-white rounded-[2.5rem] overflow-hidden relative">
                    {/* Notch */}
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-6 bg-gray-900 rounded-b-3xl z-10" />
                    
                    {/* Screenshot placeholder - replace with actual screenshot */}
                    <div className="w-full h-full bg-gradient-to-br from-brand-500 to-purple-600 flex items-center justify-center text-white p-8">
                      <div className="text-center">
                        <div className="text-4xl mb-4">📱</div>
                        <div className="text-sm font-mono">9remote</div>
                        <div className="text-xs opacity-80 mt-2">Terminal in your pocket</div>
                      </div>
                    </div>
                  </div>
                  
                  {/* Home indicator */}
                  <div className="absolute bottom-2 left-1/2 -translate-x-1/2 w-32 h-1 bg-gray-700 rounded-full" />
                </div>
                
                {/* Glow effect */}
                <div className="absolute inset-0 bg-gradient-to-br from-brand-500/30 to-purple-500/30 blur-3xl -z-10 scale-110" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* CSS for animations */}
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

        @keyframes float {
          0%, 100% {
            transform: translateY(0px);
          }
          50% {
            transform: translateY(-20px);
          }
        }

        @keyframes floatPhone {
          0%, 100% {
            transform: translateY(0px);
          }
          50% {
            transform: translateY(-15px);
          }
        }

        @keyframes pulseSlow {
          0%, 100% {
            opacity: 0.1;
            transform: scale(1);
          }
          50% {
            opacity: 0.15;
            transform: scale(1.05);
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

        .animate-float {
          animation: float 8s ease-in-out infinite;
        }

        .animate-float-delay {
          animation: float 10s ease-in-out infinite 2s;
        }

        .animate-float-phone {
          animation: floatPhone 6s ease-in-out infinite;
        }

        .animate-pulse-slow {
          animation: pulseSlow 8s ease-in-out infinite;
        }

        .bg-grid-pattern {
          background-image: 
            linear-gradient(to right, #e5e7eb 1px, transparent 1px),
            linear-gradient(to bottom, #e5e7eb 1px, transparent 1px);
          background-size: 40px 40px;
        }
      `}</style>
    </section>
  );
}
