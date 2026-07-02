// Full-screen QR scan for pairing. The barcode-scanner plugin renders
// the camera BEHIND the WKWebView (windowed mode flips the webview
// transparent), so while this overlay is mounted the page itself must
// also go transparent — `data-ae-scan` on <html> drives the CSS
// override in mobile.css. The overlay paints a dimmed frame with a
// cutout so the camera shows through the middle.

import { useEffect, useRef, useState } from "react";

import {
  Format,
  cancel,
  checkPermissions,
  openAppSettings,
  requestPermissions,
  scan,
} from "@tauri-apps/plugin-barcode-scanner";

export function ScanOverlay({
  onResult,
  onCancel,
}: {
  onResult: (text: string) => void;
  onCancel: () => void;
}) {
  const [denied, setDenied] = useState(false);
  // The callbacks live in refs so the one-shot scan effect never
  // re-runs (and re-arms the camera) on parent re-renders.
  const onResultRef = useRef(onResult);
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onResultRef.current = onResult;
    onCancelRef.current = onCancel;
  });

  useEffect(() => {
    document.documentElement.dataset.aeScan = "1";
    let disposed = false;

    const run = async () => {
      let permission = await checkPermissions();
      if (permission === "prompt") {
        permission = await requestPermissions();
      }
      if (disposed) return;
      if (permission !== "granted") {
        setDenied(true);
        return;
      }
      try {
        const scanned = await scan({ windowed: true, formats: [Format.QRCode] });
        if (!disposed) onResultRef.current(scanned.content);
      } catch {
        // Cancelled (by us or the OS) — the parent decides what's next.
        if (!disposed) onCancelRef.current();
      }
    };
    void run();

    return () => {
      disposed = true;
      delete document.documentElement.dataset.aeScan;
      void cancel().catch(() => undefined);
    };
  }, []);

  return (
    <div className="ae-scan-overlay" data-testid="scan-overlay">
      {denied ? (
        <div className="ae-scan-denied">
          <p>Camera access is off. Aethon needs it to scan the pairing QR code.</p>
          <button
            type="button"
            className="ae-mobile-connect-button"
            onClick={() => void openAppSettings()}
          >
            Open Settings
          </button>
          <button type="button" className="ae-mobile-text-button" onClick={onCancel}>
            Back
          </button>
        </div>
      ) : (
        <>
          <div className="ae-scan-cutout" aria-hidden />
          <p className="ae-scan-hint">
            Point at the QR code in Settings → Remote Devices on your desktop.
          </p>
          <button
            type="button"
            className="ae-mobile-connect-button ae-scan-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
