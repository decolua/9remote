"use client";

export default function AnimatedBackground() {
  return (
    <div className="fixed inset-0 z-0 pointer-events-none">
      {/* Grid pattern */}
      <div 
        className="absolute inset-0 opacity-[0.08]"
        style={{
          backgroundImage: `
            linear-gradient(to right, rgb(6 182 212) 1px, transparent 1px),
            linear-gradient(to bottom, rgb(6 182 212) 1px, transparent 1px)
          `,
          backgroundSize: "50px 50px"
        }}
      />

      {/* Animated gradient blobs */}
      <div className="absolute top-0 left-1/4 w-[700px] h-[700px] rounded-full bg-cyan-500/20 blur-[130px] animate-blob" />
      <div className="absolute top-1/3 right-1/4 w-[600px] h-[600px] rounded-full bg-blue-500/15 blur-[130px] animate-blob animation-delay-2000" />
      <div className="absolute bottom-0 left-1/2 w-[650px] h-[650px] rounded-full bg-sky-500/15 blur-[130px] animate-blob animation-delay-4000" />

      {/* Vignette overlay */}
      <div 
        className="absolute inset-0"
        style={{
          background: "radial-gradient(circle at center, transparent 0%, rgba(2, 6, 23, 0.5) 100%)"
        }}
      />

      {/* CSS for animations */}
      <style jsx>{`
        @keyframes blob {
          0%, 100% { 
            transform: translate(0, 0) scale(1);
          }
          33% { 
            transform: translate(30px, -50px) scale(1.1);
          }
          66% { 
            transform: translate(-20px, 20px) scale(0.9);
          }
        }

        .animate-blob {
          animation: blob 20s ease-in-out infinite;
        }

        .animation-delay-2000 {
          animation-delay: 2s;
          animation-duration: 22s;
        }

        .animation-delay-4000 {
          animation-delay: 4s;
          animation-duration: 25s;
        }
      `}</style>
    </div>
  );
}
