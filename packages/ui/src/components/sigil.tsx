import type * as React from "react";
import { PixelArt, type PixelRows } from "./pixel-art.tsx";

/** Moonlight "#" and amber "o" on the deep night plate "."; every pixel is drawn. */
const SIGIL_INKS = { "#": "#f3e9b5", o: "#f2a541", ".": "#0d0c1c" } as const;

/**
 * A role's 10 × 10 sigil on its dark plate. Decorative unless a `label` is given, since it usually
 * sits next to the role's title in words.
 */
function Sigil({
  rows,
  size,
  ...props
}: Omit<React.ComponentProps<typeof PixelArt>, "palette" | "rows"> & { rows: PixelRows }) {
  return <PixelArt data-slot="sigil" rows={rows} palette={SIGIL_INKS} size={size} {...props} />;
}

export { SIGIL_INKS, Sigil };
