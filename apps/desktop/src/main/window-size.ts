/** A rectangle in screen coordinates, such as a display's work area. */
export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The smallest window the Hobbots layout fits in. */
export const minWindowSize = { width: 960, height: 610 } as const;

/** The size the window opens at on a display small enough that 70% of it would be cramped. */
const preferredSize = { width: 1440, height: 900 } as const;

/** The share of the work area the window covers at least. */
const workAreaShare = 0.7;

/**
 * Where the window opens: at least 70% of the work area, or the preferred size when that is
 * bigger, never below the minimum nor beyond the work area, and centered in it.
 */
export const initialWindowBounds = (workArea: Bounds): Bounds => {
  const fit = (preferred: number, available: number, min: number) =>
    Math.max(min, Math.min(available, Math.max(preferred, Math.round(available * workAreaShare))));
  const width = fit(preferredSize.width, workArea.width, minWindowSize.width);
  const height = fit(preferredSize.height, workArea.height, minWindowSize.height);
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  };
};
