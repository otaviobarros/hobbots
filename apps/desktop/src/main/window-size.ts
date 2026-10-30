/** A rectangle in screen coordinates, such as a display's work area. */
export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The smallest window the Hobbots layout fits in. */
const minWindowSize = { width: 960, height: 610 } as const;

/** The size the window opens at on a display small enough that 70% of it would be cramped. */
const preferredSize = { width: 1440, height: 900 } as const;

/** The share of the work area the window covers at least. */
const workAreaShare = 0.7;

/** Where the window opens and the smallest it may be made, as BrowserWindow takes them. */
export interface WindowPlacement extends Bounds {
  readonly minWidth: number;
  readonly minHeight: number;
}

/**
 * Where the window opens: at least 70% of the work area, or the preferred size when that is
 * bigger, centered in it. Staying on screen wins over the minimum size: on a work area smaller
 * than the minimum, the window fills it and the minimum shrinks to match.
 */
export const initialWindowBounds = (workArea: Bounds): WindowPlacement => {
  const minWidth = Math.min(minWindowSize.width, workArea.width);
  const minHeight = Math.min(minWindowSize.height, workArea.height);
  const fit = (preferred: number, available: number, min: number) =>
    Math.max(min, Math.min(available, Math.max(preferred, Math.round(available * workAreaShare))));
  const width = fit(preferredSize.width, workArea.width, minWidth);
  const height = fit(preferredSize.height, workArea.height, minHeight);
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
    minWidth,
    minHeight,
  };
};
