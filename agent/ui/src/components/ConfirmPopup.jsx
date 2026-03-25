export default function ConfirmPopup({ message, confirmLabel = "Confirm", confirmDanger = false, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)" }}>
      <div className="glass-card p-5 flex flex-col gap-4 w-72">
        <p className="text-sm text-white text-center">{message}</p>
        <div className="flex gap-2">
          <button onClick={onCancel} className="glass-btn flex-1 py-2 text-sm text-white/60 hover:text-white">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-2 text-sm font-semibold rounded-xl"
            style={{ background: confirmDanger ? "rgba(220,53,69,0.8)" : "var(--brand-500)", color: "#fff" }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
