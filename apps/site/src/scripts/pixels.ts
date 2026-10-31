import { type PixelPalette, type PixelRows, pixelPaths } from "@hobbots/art/pixels";

const SVG = "http://www.w3.org/2000/svg";

/** Redraws a PixelArt drawing in place, keeping its size, label and classes. */
export const redraw = (svg: SVGSVGElement, rows: PixelRows, palette: PixelPalette) => {
  const paths = [...pixelPaths(rows, palette)].map(([fill, d]) => {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", fill);
    return path;
  });
  svg.replaceChildren(...paths);
};
