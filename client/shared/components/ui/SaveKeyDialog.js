"use client";

import Button from "./Button";

export default function SaveKeyDialog({ isOpen, onClose }) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-dark-600 rounded-brand-lg shadow-2xl max-w-md w-full border border-dark-400 p-6">
        <h2 className="text-xl font-bold text-white mb-3">
          Lưu API Key?
        </h2>
        
        <p className="text-dark-50 mb-4">
          Bạn có muốn lưu API key này trên thiết bị để sử dụng lần sau không?
        </p>

        <div className="bg-yellow-900/20 border border-yellow-700/50 rounded-lg p-3 mb-6">
          <p className="text-yellow-200 text-sm flex items-start gap-2">
            <span className="text-lg">⚠️</span>
            <span>
              Key sẽ được lưu trên thiết bị này. Chỉ lưu nếu bạn tin tưởng thiết bị này.
            </span>
          </p>
        </div>

        <div className="flex gap-3">
          <Button
            variant="primary"
            onClick={() => onClose(true)}
            className="flex-1"
          >
            Lưu
          </Button>
          <Button
            variant="secondary"
            onClick={() => onClose(false)}
            className="flex-1"
          >
            Không
          </Button>
        </div>
      </div>
    </div>
  );
}
