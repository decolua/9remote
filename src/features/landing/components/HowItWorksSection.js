"use client";

export default function HowItWorksSection() {
  const steps = [
    {
      number: "1",
      title: "Install CLI",
      description: "Install 9Remote globally via npm",
      command: "npm install -g 9remote"
    },
    {
      number: "2",
      title: "Start Server",
      description: "Launch the server and get your QR code",
      command: "9remote start"
    },
    {
      number: "3",
      title: "Connect",
      description: "Scan QR code or use access key to connect",
      command: "Access from anywhere"
    }
  ];

  return (
    <section id="how-it-works" className="relative py-20 px-4 sm:px-6 lg:px-8 bg-slate-900/30">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-4 bg-gradient-to-r from-blue-400 to-blue-500 bg-clip-text text-transparent">
            How It Works
          </h2>
          <p className="text-lg text-slate-400 max-w-2xl mx-auto">
            Get started in 3 simple steps
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 relative">
          {/* Connection lines (desktop only) */}
          <div className="hidden md:block absolute top-16 left-1/4 right-1/4 h-0.5 bg-gradient-to-r from-blue-500 via-blue-500 to-blue-500" />

          {steps.map((step, index) => (
            <div
              key={index}
              className="relative"
              style={{
                animation: `fadeInUp 0.6s ease-out ${index * 0.2}s forwards`,
                opacity: 0
              }}
            >
              {/* Step number circle */}
              <div className="flex justify-center mb-6">
                <div className="relative">
                  <div className="w-16 h-16 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-2xl font-bold text-white shadow-lg shadow-blue-500/50 relative z-10">
                    {step.number}
                  </div>
                  <div className="absolute inset-0 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 animate-ping opacity-20" />
                </div>
              </div>

              {/* Step content */}
              <div className="text-center">
                <h3 className="text-xl font-semibold text-white mb-2">
                  {step.title}
                </h3>
                <p className="text-slate-400 text-sm mb-4">
                  {step.description}
                </p>
                <div className="p-3 bg-slate-900/50 backdrop-blur-sm border border-slate-800 rounded-lg">
                  <code className="text-blue-400 font-mono text-xs sm:text-sm">
                    {step.command}
                  </code>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* CSS for animation */}
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
