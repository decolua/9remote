"use client";

import { useRouter } from "next/navigation";
import Spinner from "./Spinner";

/**
 * Connection overlay modal - shows when retrying or failed
 * @param {Object} retryStatus - { isRetrying, attempt, maxAttempts, failed }
 * @param {Function} onLogout - Callback to clear session and redirect
 */
export default function ConnectionModal({ retryStatus, onLogout }) {
  const router = useRouter();

  // Only show when retrying or failed
  if (!retryStatus?.isRetrying && !retryStatus?.failed) {
    return null;
  }

  const handleBackToLogin = () => {
    if (onLogout) {
      onLogout();
    } else {
      sessionStorage.clear();
      router.push("/login");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl">
        {retryStatus.isRetrying ? (
          // Retrying state
          <div className="text-center">
            <Spinner size="lg" />
            <h3 className="text-white text-lg font-semibold mt-4">
              Reconnecting...
            </h3>
            <p className="text-slate-400 mt-2">
              Attempt {retryStatus.attempt} of {retryStatus.maxAttempts}
            </p>
            <div className="mt-4 w-full bg-slate-700 rounded-full h-2">
              <div 
                className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                style={{ width: `${(retryStatus.attempt / retryStatus.maxAttempts) * 100}%` }}
              />
            </div>
            <button
              onClick={handleBackToLogin}
              className="mt-4 w-full py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 font-medium rounded-lg transition"
            >
              Exit
            </button>
          </div>
        ) : (
          // Failed state
          <div className="text-center">
            <div className="w-16 h-16 mx-auto bg-red-500/20 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h3 className="text-white text-lg font-semibold mt-4">
              Connection Failed
            </h3>
            <p className="text-slate-400 mt-2">
              Unable to connect after {retryStatus.maxAttempts} attempts
            </p>
            <button
              onClick={handleBackToLogin}
              className="mt-6 w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition"
            >
              Back to Login
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
