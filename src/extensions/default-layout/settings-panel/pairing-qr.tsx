// QR image for the pairing payload. Rendered as a single-path SVG from
// uqr's boolean module matrix — no canvas, so it works under jsdom and
// stays crisp at any size. The card behind it is always white: phones
// can't reliably scan light-on-dark codes, and the settings panel is
// usually a dark theme.

import { useMemo } from "react";
import { encode } from "uqr";

export function PairingQr({ payload, size = 208 }: { payload: string; size?: number }) {
  const qr = useMemo(() => encode(payload, { border: 3 }), [payload]);

  const path = useMemo(() => {
    const parts: string[] = [];
    for (let y = 0; y < qr.size; y += 1) {
      for (let x = 0; x < qr.size; x += 1) {
        if (qr.data[y][x]) parts.push(`M${x} ${y}h1v1h-1z`);
      }
    }
    return parts.join("");
  }, [qr]);

  return (
    <div className="ae-remote-qr">
      <svg
        role="img"
        aria-label="Pairing QR code"
        data-testid="remote-pairing-qr"
        width={size}
        height={size}
        viewBox={`0 0 ${qr.size} ${qr.size}`}
        shapeRendering="crispEdges"
      >
        <rect width={qr.size} height={qr.size} fill="#ffffff" />
        <path d={path} fill="#111111" />
      </svg>
    </div>
  );
}
