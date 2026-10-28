import { cn } from "cn";
import type * as React from "react";

/** A grid of color names, one string per row; "." (or a missing palette entry) is transparent. */
export type PixelRows = ReadonlyArray<string>;
export type PixelPalette = Readonly<Record<string, string>>;

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
  // One path per color keeps the DOM small even for big scenes.
  const paths = new Map<string, string>();
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const fill = palette[row[x] ?? "."];
      if (fill && fill !== "transparent") paths.set(fill, `${paths.get(fill) ?? ""}M${x} ${y}h1v1h-1z`);
    }
  });
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
