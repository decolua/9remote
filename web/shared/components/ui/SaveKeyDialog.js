"use client";

import Button from "./Button";

export default function SaveKeyDialog({ isOpen, onClose }) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-[2px] flex items-center justify-center z-50 p-4">
      <div className="card-elev max-w-md w-full p-6">
        <h2 className="text-xl font-bold text-text mb-3">
          Save API Key?
        </h2>
        
        <p className="text-text mb-4">
          Do you want to save this API key on this device for later use?
        </p>

        <div className="bg-yellow-500/10 rounded-brand p-3 mb-6">
          <p className="text-yellow-200 text-sm flex items-start gap-2">
            <span className="text-lg">⚠️</span>
            <span>
              The key will be stored on this device. Only save if you trust this device.
            </span>
          </p>
        </div>

        <div className="flex gap-3">
          <Button
            variant="primary"
            onClick={() => onClose(true)}
            className="flex-1"
          >
            Save
          </Button>
          <Button
            variant="secondary"
            onClick={() => onClose(false)}
            className="flex-1"
          >
            No
          </Button>
        </div>
      </div>
    </div>
  );
}
