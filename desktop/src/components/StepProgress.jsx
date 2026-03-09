import React from "react"

const stepIcons = ["play_arrow", "lan", "verified_user", "check_circle"]

export default function StepProgress({ currentStep, steps }) {
  const percent = Math.round((currentStep / (steps.length - 1)) * 100)

  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-white/50 font-medium uppercase tracking-wider">Progress</span>
        <span className="text-xs text-blue-400 font-semibold">{percent}%</span>
      </div>

      <div className="relative flex items-center justify-between">
        {/* connecting line */}
        <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-px bg-white/10 mx-5" />
        <div
          className="absolute left-5 top-1/2 -translate-y-1/2 h-px bg-blue-500 transition-all duration-700"
          style={{ width: `calc(${percent}% - 40px)` }}
        />

        {steps.map((label, i) => {
          const completed = i < currentStep
          const active = i === currentStep

          return (
            <div key={i} className="relative flex flex-col items-center gap-1.5 z-10">
              <div className="relative flex items-center justify-center w-8 h-8 rounded-full">
                {/* pulse ring for active */}
                {active && (
                  <div className="absolute inset-0 rounded-full bg-blue-500/30 pulse-ring" />
                )}
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center
                    ${completed ? "bg-blue-500" : active ? "bg-blue-500" : "bg-white/10"}`}
                >
                  {completed ? (
                    <span className="material-symbols-outlined text-white text-sm">check</span>
                  ) : active ? (
                    <span className="material-symbols-outlined text-white text-sm spin">{stepIcons[i]}</span>
                  ) : (
                    <span className="material-symbols-outlined text-white/30 text-sm">{stepIcons[i]}</span>
                  )}
                </div>
              </div>
              <span
                className={`text-xs font-medium whitespace-nowrap
                  ${completed ? "text-blue-400" : active ? "text-white" : "text-white/30"}`}
              >
                {label}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
