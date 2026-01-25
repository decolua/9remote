"use client";

export default function AnimatedBackground() {
  return (
    <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none" style={{ background: "#0a0e27" }}>
      {/* Grid pattern */}
      <div 
        className="absolute inset-0 opacity-[0.08]"
        style={{
          backgroundImage: `
            linear-gradient(to right, #00ff9f 1px, transparent 1px),
            linear-gradient(to bottom, #00ff9f 1px, transparent 1px)
          `,
          backgroundSize: "50px 50px"
        }}
      />

      {/* Blob 1 - Green */}
      <div 
        className="blob blob-1"
        style={{
          position: "absolute",
          top: 0,
          left: "25%",
          width: "700px",
          height: "700px",
          borderRadius: "50%",
          background: "rgba(0, 255, 159, 0.18)",
          filter: "blur(130px)",
          animation: "blob 20s ease-in-out infinite"
        }}
      />

      {/* Blob 2 - Cyan */}
      <div 
        className="blob blob-2"
        style={{
          position: "absolute",
          top: "33%",
          right: "25%",
          width: "600px",
          height: "600px",
          borderRadius: "50%",
          background: "rgba(0, 217, 255, 0.15)",
          filter: "blur(130px)",
          animation: "blob 22s ease-in-out infinite",
          animationDelay: "2s"
        }}
      />

      {/* Blob 3 - Magenta */}
      <div 
        className="blob blob-3"
        style={{
          position: "absolute",
          bottom: 0,
          left: "50%",
          width: "650px",
          height: "650px",
          borderRadius: "50%",
          background: "rgba(255, 0, 255, 0.12)",
          filter: "blur(130px)",
          animation: "blob 25s ease-in-out infinite",
          animationDelay: "4s"
        }}
      />

      {/* Vignette overlay */}
      <div 
        className="absolute inset-0"
        style={{
          background: "radial-gradient(circle at center, transparent 0%, rgba(10, 14, 39, 0.5) 100%)"
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
