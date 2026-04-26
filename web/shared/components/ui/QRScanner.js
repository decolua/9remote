"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { X, AlertCircle } from "./Icon";
import Button from "./Button";

/**
 * QR Scanner Modal Component
 * Uses html5-qrcode library from CDN
 */
export default function QRScanner({ isOpen, onClose, onScan }) {
  const scannerRef = useRef(null);
  const html5QrCodeRef = useRef(null);
  const [error, setError] = useState("");
  const [scanStatus, setScanStatus] = useState(""); // "detected" | "authenticating" | ""
  const [status, setStatus] = useState("Loading library...");

  // Load html5-qrcode from CDN
  useEffect(() => {
    if (typeof window === "undefined") return;
    
    // Check if already loaded
    if (window.Html5Qrcode) {
      setStatus("Library loaded ✓");
      return;
    }

    setStatus("Loading html5-qrcode from CDN...");

    const script = document.createElement("script");
    script.src = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
    script.async = true;
    script.onload = () => {
      setStatus("Library loaded ✓");
    };
    script.onerror = () => {
      setError("Failed to load QR scanner library from CDN");
      setStatus("Library load FAILED ✗");
    };
    document.body.appendChild(script);
  }, []);

  // Handle scan result
  const handleScanResult = useCallback(async (data) => {
    setStatus(`Scanned: ${data.substring(0, 30)}...`);
    
    // Stop scanner immediately to prevent multiple scans
    if (html5QrCodeRef.current) {
      try {
        await html5QrCodeRef.current.stop();
      } catch (e) {
        // Ignore stop errors
      }
    }

    try {
      // Parse URL to extract temp key
      const url = new URL(data);
      const tempKey = url.searchParams.get("k");

      if (tempKey) {
        setScanStatus("detected");
        setStatus(`Key found: ${tempKey}`);
        await new Promise(resolve => setTimeout(resolve, 500));
        setScanStatus("authenticating");
        setStatus("Authenticating...");
        await onScan(tempKey);
      } else {
        setError("Invalid QR code. No key found in URL.");
        setStatus("No 'k' param in URL");
      }
    } catch (err) {
      // Not a valid URL, check if direct temp key
      if (data && /^[A-Z0-9]{6}$/i.test(data)) {
        setScanStatus("detected");
        setStatus(`Direct key: ${data.toUpperCase()}`);
        await new Promise(resolve => setTimeout(resolve, 500));
        setScanStatus("authenticating");
        setStatus("Authenticating...");
        await onScan(data.toUpperCase());
      } else {
        setError(`Invalid QR: ${data.substring(0, 50)}`);
        setStatus("Invalid format");
      }
    }
  }, [onScan]);

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
    setStatus("Closed");
    onClose();
  }, [onClose]);

  // Initialize scanner when modal opens
  useEffect(() => {
    if (!isOpen) return;
    
    // Wait for library to load
    if (!window.Html5Qrcode) {
      setStatus("Waiting for library...");
      const checkInterval = setInterval(() => {
        if (window.Html5Qrcode) {
          clearInterval(checkInterval);
          initScanner();
        }
      }, 100);
      
      // Timeout after 10 seconds
      setTimeout(() => {
        clearInterval(checkInterval);
        if (!window.Html5Qrcode) {
          setError("Library failed to load after 10s");
          setStatus("Timeout loading library");
        }
      }, 10000);
      
      return () => clearInterval(checkInterval);
    }

    initScanner();

    async function initScanner() {
      // Wait for DOM element to be ready
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const element = document.getElementById("qr-reader");
      if (!element) {
        setError("Scanner element not found");
        setStatus("DOM element missing");
        return;
      }

      try {
        setStatus("Creating scanner instance...");
        
        // Clear any existing content
        element.innerHTML = "";
        
        const html5QrCode = new window.Html5Qrcode("qr-reader");
        html5QrCodeRef.current = html5QrCode;

        setStatus("Requesting camera access...");

        const config = {
          fps: 10,
          qrbox: { width: 250, height: 250 },
        };

        await html5QrCode.start(
          { facingMode: "environment" },
          config,
          (decodedText) => {
            handleScanResult(decodedText);
          },
          (errorMessage) => {
            // Scan error - just ignore and keep scanning
          }
        );

        setStatus("Camera active - scanning...");

      } catch (err) {
        const errStr = err.toString();
        setStatus(`Error: ${errStr.substring(0, 50)}`);
        
        if (errStr.includes("NotAllowedError")) {
          setError("Camera permission denied. Please allow camera access and try again.");
        } else if (errStr.includes("NotFoundError")) {
          setError("No camera found on this device.");
        } else if (errStr.includes("NotReadableError")) {
          setError("Camera is in use by another app.");
        } else {
          setError(`Camera error: ${err.message || errStr}`);
        }
      }
    }

    return () => {
      if (html5QrCodeRef.current) {
        html5QrCodeRef.current.stop().catch(() => {});
        html5QrCodeRef.current = null;
      }
    };
  }, [isOpen, handleScanResult]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="relative card-elev max-w-md w-full mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-xl font-bold text-text">Scan QR Code</h2>
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
          {/* Debug status - always show */}
          <div className="mb-3 p-2 bg-bg rounded text-xs font-mono text-text-muted break-all">
            Status: {status}
          </div>

          {error ? (
            <div className="flex items-start gap-2 p-3 bg-red-500/10 rounded-brand text-red-400">
              <AlertCircle size={20} className="flex-shrink-0 mt-0.5" />
              <p className="text-sm">{error}</p>
            </div>
          ) : scanStatus === "detected" ? (
            <div className="flex items-center justify-center gap-2 p-3 bg-green-500/10 rounded-brand text-green-400">
              <div className="text-2xl">✓</div>
              <p className="text-sm font-medium">QR Code detected!</p>
            </div>
          ) : scanStatus === "authenticating" ? (
            <div className="flex items-center justify-center gap-2 p-3 bg-brand-500/10 rounded-brand text-brand-400">
              <div className="animate-spin">⏳</div>
              <p className="text-sm font-medium">Authenticating...</p>
            </div>
          ) : (
            <p className="text-sm text-text-muted text-center">
              Point camera at the QR code from CLI
            </p>
          )}

          {/* Close button */}
          <Button
            variant="secondary"
            onClick={handleClose}
            disabled={scanStatus === "authenticating"}
            className="w-full mt-4"
          >
            {scanStatus === "authenticating" ? "Please wait..." : "Cancel"}
          </Button>
        </div>
      </div>
    </div>
  );
}
