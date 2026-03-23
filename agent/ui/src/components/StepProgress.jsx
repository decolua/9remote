const stepIcons = ["play_arrow", "lan", "verified_user", "check_circle"];

export default function StepProgress({ currentStep, steps }) {
  const percent = Math.round((currentStep / (steps.length - 1)) * 100);

  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-white/50 font-medium uppercase tracking-wider">Progress</span>
        <span className="text-xs font-semibold" style={{ color: "var(--brand-500)" }}>{percent}%</span>
      </div>

      <div className="relative flex items-center justify-between">
        <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-px bg-white/10 mx-5" />
        <div
          className="absolute left-5 top-1/2 -translate-y-1/2 h-px transition-all duration-700"
          style={{ background: "var(--brand-500)", width: `calc(${percent}% - 40px)` }}
        />

        {steps.map((label, i) => {
          const completed = i < currentStep;
          const active = i === currentStep;

          return (
            <div key={i} className="relative flex flex-col items-center gap-1.5 z-10">
              <div className="relative flex items-center justify-center w-8 h-8 rounded-full">
                {active && <div className="absolute inset-0 rounded-full pulse-ring" style={{ background: "rgba(255,87,10,0.3)" }} />}
                <div className={`w-8 h-8 rounded-full flex items-center justify-center ${completed || active ? "" : "bg-white/10"}`} style={completed || active ? { background: "var(--brand-500)" } : {}}>
                  {completed ? (
                    <span className="material-symbols-outlined text-white text-sm">check</span>
                  ) : active ? (
                    <span className="material-symbols-outlined text-white text-sm spin">{stepIcons[i]}</span>
                  ) : (
                    <span className="material-symbols-outlined text-white/30 text-sm">{stepIcons[i]}</span>
                  )}
                </div>
              </div>
              <span className={`text-xs font-medium whitespace-nowrap ${active ? "text-white" : "text-white/30"}`} style={completed ? { color: "var(--brand-400)" } : {}}>
                {label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
