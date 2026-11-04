import { SIGIL_INKS } from "@hobbots/art/sigil";
import type * as React from "react";
import { PixelArt, type PixelRows } from "./pixel-art.tsx";

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

export { Sigil };
