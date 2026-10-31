/** A grid of color names, one string per row; "." (or a missing palette entry) is transparent. */
export type PixelRows = ReadonlyArray<string>;
export type PixelPalette = Readonly<Record<string, string>>;

/** The SVG path of each color in a drawing, one unit per cell. One path per color keeps the DOM small. */
export const pixelPaths = (rows: PixelRows, palette: PixelPalette): Map<string, string> => {
  const paths = new Map<string, string>();
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const fill = palette[row[x] ?? "."];
      if (fill && fill !== "transparent") paths.set(fill, `${paths.get(fill) ?? ""}M${x} ${y}h1v1h-1z`);
    }
  });
  return paths;
};
