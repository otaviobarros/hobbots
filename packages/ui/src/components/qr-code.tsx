import type * as React from "react";
import { encode } from "uqr";
import { cn } from "../lib/utils.ts";
import { PixelArt } from "./pixel-art.tsx";

/** The QR code's modules as pixel rows: `#` for a dark module, `.` for a light one, with a quiet zone. */
export const qrRows = (text: string): ReadonlyArray<string> =>
  encode(text, { ecc: "M", border: 2 }).data.map((row) => row.map((dark) => (dark ? "#" : ".")).join(""));

/**
 * A QR code drawn as crisp pixel art, dark on light whatever the theme, so every phone camera reads
 * it. `label` names it for screen readers, such as the address it holds.
 */
function QrCode({
  value,
  label,
  size,
  className,
  ...props
}: Omit<React.ComponentProps<"span">, "children"> & { value: string; label: string; size: number }) {
  return (
    <span data-slot="qr-code" className={cn("block bg-text-strong text-ground", className)} {...props}>
      <PixelArt rows={qrRows(value)} palette={{ "#": "currentColor" }} size={size} label={label} />
    </span>
  );
}

export { QrCode };
