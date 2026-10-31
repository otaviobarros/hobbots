/**
 * What the menu-bar icon draws and says, and what closing the window does (design screen 14,
 * ADR 012). Pure, so the rules are testable without Electron; menu-bar.ts puts them on screen.
 */
import type { ServerState, ServerStatus } from "./server.ts";

/** The chief of the hobs in 10 × 10 cells, as the design draws it for the menu bar; "." and "k" (eyes) are clear. */
const TRAY_CHIEF = [
  ".g..g..g..",
  ".gggggggg.",
  "..hhhhhh.l",
  ".hhhhhhhhl",
  "s.ssssss.l",
  "ssksssskls",
  ".ssssssssl",
  "..cccccc.l",
  ".cccccccc.",
  "..bb..bb..",
] as const;

/** The icon's size in points; the bitmap is this times the scale factor. */
export const TRAY_SIZE = 16;

/** Starting and Stopped dim the chief; Error adds a square badge at the bottom right. */
const look = (state: ServerState) => ({
  alpha: state === "starting" || state === "stopped" ? 115 : 255,
  badge: state === "error",
});

/**
 * Renders the template image for one scale factor as 32-bit pixels, black with alpha. macOS uses
 * only the alpha of a template image, so the channel order of the platform's bitmap does not matter.
 * Cells are whole pixels: 1 px at 1×, 3 px at 2×.
 */
export const renderTrayIcon = (state: ServerState, scale: 1 | 2): Buffer => {
  const size = TRAY_SIZE * scale;
  const cell = Math.floor(size / TRAY_CHIEF.length);
  const offset = Math.floor((size - cell * TRAY_CHIEF.length) / 2);
  const { alpha, badge } = look(state);
  const pixels = Buffer.alloc(size * size * 4);
  const badgeSize = 4 * scale;
  // The badge sits in a clear ring so it reads apart from the chief.
  const clearFrom = size - badgeSize - scale;
  const set = (x: number, y: number, a: number) => {
    pixels[(y * size + x) * 4 + 3] = a;
  };
  TRAY_CHIEF.forEach((row, gy) => {
    [...row].forEach((ch, gx) => {
      if (ch === "." || ch === "k") return;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) set(offset + gx * cell + x, offset + gy * cell + y, alpha);
      }
    });
  });
  if (badge) {
    for (let y = clearFrom; y < size; y++) {
      for (let x = clearFrom; x < size; x++) set(x, y, x >= size - badgeSize && y >= size - badgeSize ? 255 : 0);
    }
  }
  return pixels;
};

/** "Aldric", "Aldric and Pip", "Aldric, Pip and Tinker". */
export const listNames = (names: ReadonlyArray<string>) => {
  const unique = [...new Set(names)];
  if (unique.length <= 1) return unique.join("");
  return `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`;
};

const hobsWorking = (count: number) =>
  count === 0 ? "No hobs working" : `${count} ${count === 1 ? "hob" : "hobs"} working`;

export interface TrayModel {
  readonly tooltip: string;
  readonly title: string;
  readonly detail: string;
  /** Offer to start the server again from the menu. */
  readonly canRestart: boolean;
}

/** The menu's header and the icon's tooltip for the server's state. */
export const trayModel = (status: ServerStatus, working: ReadonlyArray<string>, port: number): TrayModel => {
  const count = new Set(working).size;
  switch (status.state) {
    case "starting":
      return {
        tooltip: "Hobbots is starting",
        title: "Hobbots is starting…",
        detail: "Opening the server and catching up on work",
        canRestart: false,
      };
    case "running":
      return {
        tooltip: `Hobbots is running · ${hobsWorking(count)}`,
        title: status.stopping ? "Hobbots is stopping…" : "Hobbots is running",
        detail: `${hobsWorking(count)} · localhost:${port}`,
        canRestart: false,
      };
    case "stopped":
      return {
        tooltip: "Hobbots: the server is stopped",
        title: "The server is stopped",
        detail: "Hobs are not working",
        canRestart: true,
      };
    case "error":
      return {
        tooltip: "Hobbots: the server hit a problem",
        title: "The server hit a problem",
        detail: status.problem ?? "Start it again, or quit and reopen Hobbots",
        canRestart: true,
      };
  }
};

export type CloseAction =
  /** Let the window close; the app, the server and running work stay alive. */
  | "close"
  /** Quit Hobbots as Quit does. */
  | "quit"
  /** Ask first, because quitting stops hobs that are working. */
  | "confirm";

/** What closing a window does, from the "Keep running in the menu bar" switch (ADR 012). */
export const closeAction = (options: {
  readonly keepRunning: boolean;
  /** The app is already quitting, so windows close as part of it. */
  readonly quitting: boolean;
  /** Other windows stay open after this one closes. */
  readonly otherWindows: boolean;
  /** The hobs that are working, or null when the server could not say. */
  readonly working: ReadonlyArray<string> | null;
}): CloseAction => {
  if (options.keepRunning || options.quitting || options.otherWindows) return "close";
  return options.working === null || options.working.length > 0 ? "confirm" : "quit";
};

/** The dialog shown before closing the window quits Hobbots while hobs are, or may be, working. */
export const quitWhileWorkingDialog = (working: ReadonlyArray<string> | null) =>
  working === null
    ? {
        message: "Quit Hobbots?",
        detail:
          "Hobbots could not check whether hobs are working. Any work in progress will stop and come back as interrupted next time you open Hobbots.",
        buttons: ["Quit", "Cancel"],
      }
    : {
        message: "Quit Hobbots while hobs are working?",
        detail: `${listNames(working)} will stop. Their unfinished work comes back as interrupted next time you open Hobbots.`,
        buttons: ["Quit", "Cancel"],
      };
