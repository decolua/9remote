"use client";

export default function FeaturesSection() {
  const features = [
    {
      icon: "🖥️",
      title: "Remote Terminal",
      description: "Full terminal access from browser with XTerm.js. Execute commands in real-time."
    },
    {
      icon: "🎮",
      title: "Remote Desktop",
      description: "Control your desktop remotely with mouse and keyboard support. Stream your screen."
    },
    {
      icon: "🔐",
      title: "QR Code Auth",
      description: "Instant connection with QR scan. No manual key entry needed."
    },
    {
      icon: "🌐",
      title: "Auto Tunnel",
      description: "Cloudflare tunnel automatically created. No port forwarding or firewall config."
    },
    {
      icon: "🔄",
      title: "Multi-Session",
      description: "Manage multiple terminal sessions simultaneously. Switch between them easily."
    },
    {
      icon: "⚡",
      title: "Real-time Sync",
      description: "Socket.io powered instant synchronization. Low latency, high performance."
    }
  ];

  return (
    <section id="features" className="relative py-20 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-4 bg-gradient-to-r from-cyan-400 to-blue-400 bg-clip-text text-transparent">
            Powerful Features
          </h2>
          <p className="text-lg text-slate-400 max-w-2xl mx-auto">
            Everything you need for secure remote access
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature, index) => (
            <div
              key={index}
              className="group p-6 bg-slate-900/50 backdrop-blur-sm border border-slate-800 rounded-xl hover:border-cyan-500/50 transition-all duration-300 hover:scale-105 hover:shadow-lg hover:shadow-cyan-500/10"
              style={{
                animation: `fadeInUp 0.6s ease-out ${index * 0.1}s forwards`,
                opacity: 0
              }}
            >
              <div className="text-4xl mb-4 group-hover:scale-110 transition-transform duration-300">
                {feature.icon}
              </div>
              <h3 className="text-xl font-semibold text-white mb-2 group-hover:text-cyan-400 transition-colors duration-300">
                {feature.title}
              </h3>
              <p className="text-slate-400 text-sm">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* CSS for staggered fade-in animation */}
      <style jsx>{`
        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(30px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </section>
  );
}
