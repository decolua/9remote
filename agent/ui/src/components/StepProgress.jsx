const STEPS_META = [
  { icon: "download", label: "Preparing", desc: "Checking tunnel binary" },
  { icon: "cloud_sync", label: "Connecting", desc: "Creating session" },
  { icon: "lan", label: "Tunneling", desc: "Starting secure tunnel" },
  { icon: "check_circle", label: "Ready", desc: "Connected" },
];

// currentStep: 1=Preparing, 2=Connecting, 3=Tunneling, (4=Ready handled by parent)
export default function StepProgress({ currentStep }) {
  // map step (1-based) to 0-based index
  const activeIdx = currentStep - 1;
  return (
    <div className="glass-card p-5 flex flex-col gap-4">
      <span className="text-xs text-white/50 font-medium uppercase tracking-wider">Setting up connection</span>
      <div className="flex flex-col gap-3">
        {STEPS_META.map((meta, i) => {
          const completed = i < activeIdx;
          const active = i === activeIdx;
          const pending = i > currentStep;

          return (
            <div key={i} className="flex items-center gap-3">
              {/* step indicator */}
              <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
                style={{
                  background: completed ? "var(--brand-500)"
                    : active ? "rgba(255,87,10,0.15)"
                    : "rgba(255,255,255,0.06)",
                  border: active ? "1.5px solid var(--brand-500)" : "1.5px solid transparent",
                }}>
                {completed ? (
                  <span className="material-symbols-outlined text-white" style={{ fontSize: 16 }}>check</span>
                ) : active ? (
                  /* dots spinner — 3 bouncing dots */
                  <span className="flex gap-0.5 items-center">
                    {[0, 1, 2].map((d) => (
                      <span key={d} className="w-1 h-1 rounded-full bg-orange-400 dot-bounce"
                        style={{ animationDelay: `${d * 0.18}s` }} />
                    ))}
                  </span>
                ) : (
                  <span className="material-symbols-outlined text-white/20" style={{ fontSize: 16 }}>{meta.icon}</span>
                )}
              </div>

              {/* text */}
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium ${completed ? "text-white/60" : active ? "text-white" : "text-white/25"}`}>
                  {meta.label}
                </p>
                <p className={`text-xs mt-0.5 ${active ? "text-white/40" : "text-white/20"}`}>
                  {meta.desc}
                </p>
              </div>

              {/* right badge */}
              {completed && (
                <span className="text-xs text-white/30 flex-shrink-0">Done</span>
              )}
              {active && (
                <span className="text-xs flex-shrink-0 px-2 py-0.5 rounded-full"
                  style={{ background: "rgba(255,87,10,0.15)", color: "var(--brand-400)" }}>
                  Running
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
