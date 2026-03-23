"use client";

export default function AnimatedBackground() {

  return null;
  
  return (
    <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none" style={{ background: "transparent" }}>
      {/* Grid pattern */}
      <div 
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `
            linear-gradient(to right, #E68A6E 1px, transparent 1px),
            linear-gradient(to bottom, #E68A6E 1px, transparent 1px)
          `,
          backgroundSize: "50px 50px"
        }}
      />

      {/* Blob 1 - Warm orange */}
      <div 
        className="blob blob-1"
        style={{
          position: "absolute",
          top: 0,
          left: "25%",
          width: "700px",
          height: "700px",
          borderRadius: "50%",
          background: "rgba(230, 138, 110, 0.08)",
          filter: "blur(130px)",
          animation: "blob 20s ease-in-out infinite"
        }}
      />

      {/* Blob 2 - Light peach */}
      <div 
        className="blob blob-2"
        style={{
          position: "absolute",
          top: "33%",
          right: "25%",
          width: "600px",
          height: "600px",
          borderRadius: "50%",
          background: "rgba(250, 229, 222, 0.5)",
          filter: "blur(130px)",
          animation: "blob 22s ease-in-out infinite",
          animationDelay: "2s"
        }}
      />

      {/* Blob 3 - Soft coral */}
      <div 
        className="blob blob-3"
        style={{
          position: "absolute",
          bottom: 0,
          left: "50%",
          width: "650px",
          height: "650px",
          borderRadius: "50%",
          background: "rgba(244, 203, 189, 0.4)",
          filter: "blur(130px)",
          animation: "blob 25s ease-in-out infinite",
          animationDelay: "4s"
        }}
      />

      {/* Light vignette overlay */}
      <div 
        className="absolute inset-0"
        style={{
          background: "radial-gradient(circle at center, transparent 0%, rgba(255, 255, 255, 0.3) 100%)"
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
      `}</style>
    </div>
  );
}
