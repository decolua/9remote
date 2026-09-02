"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { X, AlertCircle, QrCode } from "./Icon";
import Button from "./Button";
import { useI18n } from "@/shared/i18n";

/**
 * QR Scanner Modal Component
 * Uses the bundled html5-qrcode library, imported on demand.
 * Hands the raw scanned string to onScan — the caller (login page) owns
 * parsing, including the TAIL that rides the URL fragment.
 */
export default function QRScanner({ isOpen, onClose, onScan }) {
  const { t } = useI18n();
  const scannerRef = useRef(null);
  const html5QrCodeRef = useRef(null);
  const ctorRef = useRef(null);
  // Latest scan handler + restart fn, wired by the open-effect (refs stay out of render)
  const scanCbRef = useRef(null);
  const restartRef = useRef(null);
  const [error, setError] = useState("");
  const [scanStatus, setScanStatus] = useState(""); // "detected" | "authenticating" | ""

  // Handle scan result — hand the raw string to the caller, which parses both
  // a full URL (fragment carries the whole code incl. TAIL) and a bare code.
  // A failed login restarts the camera; a burned code needs a fresh one anyway.
  const handleScanResult = useCallback(async (data) => {
    // Stop scanner immediately to prevent multiple scans
    if (html5QrCodeRef.current) {
      try {
        await html5QrCodeRef.current.stop();
      } catch (e) {
        // Ignore stop errors
      }
    }

    setScanStatus("detected");
    await new Promise(resolve => setTimeout(resolve, 300));
    setScanStatus("authenticating");
    const ok = await onScan(data);
    if (!ok) {
      setScanStatus("");
      restartRef.current?.();
    }
  }, [onScan]);

  // Start the camera against #qr-reader. Stale instances are discarded first —
  // html5-qrcode refuses start() on a stopped one.
  const startScanner = useCallback(async () => {
    if (!ctorRef.current) {
      const mod = await import("html5-qrcode").catch(() => null);
      if (!mod) { setError(t("login.qrLibFail")); return; }
      ctorRef.current = mod.Html5Qrcode;
    }
    const element = document.getElementById("qr-reader");
    if (!element) { setError(t("login.qrInitFail")); return; }

    try {
      element.innerHTML = "";
      const html5QrCode = new ctorRef.current("qr-reader");
      html5QrCodeRef.current = html5QrCode;
      await html5QrCode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => { scanCbRef.current?.(decodedText); },
        () => {} // scan error - keep scanning
      );
    } catch (err) {
      const errStr = err.toString();
      if (errStr.includes("NotAllowedError")) setError(t("login.qrCamDenied"));
      else if (errStr.includes("NotFoundError")) setError(t("login.qrNoCamera"));
      else if (errStr.includes("NotReadableError")) setError(t("login.qrCamBusy"));
      else setError(t("login.qrCamError"));
    }
  }, [t]);

  // Handle close
  const handleClose = useCallback(async () => {
    if (html5QrCodeRef.current) {
      try {
        await html5QrCodeRef.current.stop();
      } catch (e) {
        // Ignore
      }
      html5QrCodeRef.current = null;
    }
    setError("");
    setScanStatus("");
    onClose();
  }, [onClose]);

  // Keep the latest scan handler reachable from the long-lived scanner closure.
  // Cheap re-assign — must NOT be in the open effect below: onScan changes
  // identity on every parent render (authenticateWithToken flips loading state
  // mid-scan) and putting it there would stop/restart the camera mid-auth.
  useEffect(() => {
    scanCbRef.current = handleScanResult;
  }, [handleScanResult]);

  // Open the camera while mounted; release it on close. Depends on isOpen only.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    restartRef.current = async () => {
      html5QrCodeRef.current = null;
      await new Promise(resolve => setTimeout(resolve, 400));
      if (!cancelled) startScanner();
    };
    const timer = setTimeout(() => { if (!cancelled) startScanner(); }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      restartRef.current = null;
      if (html5QrCodeRef.current) {
        // stop() throws synchronously (not a rejected promise) when the
        // scanner is already stopped — e.g. handleScanResult stopped it
        // before navigation unmounted the modal.
        try { html5QrCodeRef.current.stop(); } catch (e) { /* already stopped */ }
        html5QrCodeRef.current = null;
      }
    };
  }, [isOpen, startScanner]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="relative card-elev max-w-md w-full mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-xl font-bold text-text">{t("login.qrScanTitle")}</h2>
          <button
            onClick={handleClose}
            className="text-text-muted hover:text-text transition-colors p-1"
          >
            <X size={24} />
          </button>
        </div>

        {/* Scanner Container */}
        <div className="relative bg-black">
          <div
            id="qr-reader"
            ref={scannerRef}
            className="w-full"
            style={{ minHeight: "300px" }}
          />
        </div>

        {/* Status & Instructions */}
        <div className="p-4">
          {error ? (
            <div className="flex items-start gap-2 p-3 bg-red-500/10 rounded-brand text-red-400">
              <AlertCircle size={20} className="flex-shrink-0 mt-0.5" />
              <p className="text-sm">{error}</p>
            </div>
          ) : scanStatus === "detected" ? (
            <div className="flex items-center justify-center gap-2 p-3 bg-green-500/10 rounded-brand text-green-400">
              <QrCode size={22} />
              <p className="text-sm font-medium">{t("login.qrDetected")}</p>
            </div>
          ) : scanStatus === "authenticating" ? (
            <div className="flex items-center justify-center gap-2 p-3 bg-brand-500/10 rounded-brand text-brand-400">
              <p className="text-sm font-medium">{t("login.qrAuthenticating")}</p>
            </div>
          ) : (
            <p className="text-sm text-text-muted text-center">
              {t("login.qrHint")}
            </p>
          )}

          {/* Close button */}
          <Button
            variant="secondary"
            onClick={handleClose}
            disabled={scanStatus === "authenticating"}
            className="w-full mt-4"
          >
            {scanStatus === "authenticating" ? t("login.qrPleaseWait") : t("common.cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}