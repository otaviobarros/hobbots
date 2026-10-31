import { type PixelPalette, type PixelRows, pixelPaths } from "@hobbots/art/pixels";
import { cn } from "cn";
import type * as React from "react";

export type { PixelPalette, PixelRows };

/** Draws pixel art as crisp SVG. Decorative unless a `label` is given. */
function PixelArt({
  rows,
  palette,
  size,
  label,
  className,
  ...props
}: Omit<React.ComponentProps<"svg">, "children"> & {
  rows: PixelRows;
  palette: PixelPalette;
  size: number;
  label?: string;
}) {
  const width = Math.max(...rows.map((row) => row.length));
  const paths = pixelPaths(rows, palette);
  return (
    <svg
      data-slot="pixel-art"
      viewBox={`0 0 ${width} ${rows.length}`}
      width={size}
      height={(size * rows.length) / width}
      shapeRendering="crispEdges"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("block shrink-0", className)}
      {...props}
    >
      {[...paths].map(([fill, d]) => (
        <path key={fill} d={d} fill={fill} />
      ))}
    </svg>
  );
}

export { PixelArt };
