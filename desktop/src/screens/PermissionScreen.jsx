import React from "react"

const permissionConfig = [
  {
    type: "screenRecording",
    icon: "screen_record",
    label: "Ghi màn hình",
    desc: "Cần thiết để chia sẻ màn hình từ xa",
  },
  {
    type: "accessibility",
    icon: "accessibility_new",
    label: "Trợ năng",
    desc: "Cần thiết để điều khiển bàn phím & chuột",
  },
]

function StatusDot({ granted }) {
  if (granted) {
    return <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
  }
  return <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
}

export default function PermissionScreen({ permissions, onRequestPermission, onContinue }) {
  const allGranted = permissions.screenRecording && permissions.accessibility

  return (
    <div className="h-full flex flex-col bg-[#0f1923]">
      {/* header */}
      <div
        className="flex items-center justify-between px-5 py-4 border-b border-white/5"
        data-tauri-drag-region
      >
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-blue-500 flex items-center justify-center">
            <span className="material-symbols-outlined text-white text-base">terminal</span>
          </div>
          <span className="font-semibold text-sm text-white">9Remote</span>
        </div>
        <button
          className="glass-btn w-7 h-7 flex items-center justify-center text-white/40 hover:text-white"
          onClick={() => window.__TAURI__?.window?.getCurrent()?.close()}
        >
          <span className="material-symbols-outlined text-sm">close</span>
        </button>
      </div>

      {/* content */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 gap-6">
        <div className="text-center">
          <h1 className="text-lg font-semibold text-white">Thiết lập quyền truy cập</h1>
          <p className="text-xs text-white/40 mt-1.5 leading-relaxed">
            9Remote cần các quyền sau để hoạt động đúng chức năng
          </p>
        </div>

        <div className="w-full flex flex-col gap-3">
          {permissionConfig.map(({ type, icon, label, desc }) => {
            const granted = permissions[type]
            return (
              <div key={type} className="glass-card p-4 flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-blue-400">{icon}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <StatusDot granted={granted} />
                    <p className="text-sm font-medium text-white">{label}</p>
                  </div>
                  <p className="text-xs text-white/40 mt-0.5">{desc}</p>
                </div>
                {!granted && (
                  <button
                    onClick={() => onRequestPermission(type)}
                    className="btn-primary px-3 py-1.5 text-xs font-medium text-white shrink-0"
                  >
                    Cấp quyền
                  </button>
                )}
                {granted && (
                  <span className="material-symbols-outlined text-green-400 text-lg shrink-0">
                    check_circle
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* footer */}
      <div className="px-6 pb-6 flex flex-col items-center gap-3">
        <button
          onClick={onContinue}
          disabled={!allGranted}
          className="btn-primary w-full py-3 text-sm font-semibold text-white"
        >
          Tiếp tục
        </button>
        <div className="flex items-center gap-1.5 text-white/30">
          <span className="material-symbols-outlined text-sm">lock</span>
          <span className="text-xs">Quyền riêng tư được bảo mật</span>
        </div>
      </div>

      {/* decoration */}
      <div className="absolute bottom-20 right-6 opacity-5 pointer-events-none">
        <span className="material-symbols-outlined text-8xl text-white">security</span>
      </div>
    </div>
  )
}
