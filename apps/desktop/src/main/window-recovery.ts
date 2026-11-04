/**
 * What a window does when its page fails (STD-DESKTOP-010): a crashed page loads again by itself, a
 * page that fails to load is tried again, and a hung page asks the user. Each failure is logged, and
 * one that keeps happening asks the user what to do, so a window never stays blank or frozen with no
 * way out. Electron stays out of this file; app-window.ts passes the window's page in.
 */
import type { WebContents } from "electron";
import { messages } from "./messages.ts";

const copy = messages.window;

/** The part of a window's `webContents` this watches and drives. */
export type WatchedPage = Pick<WebContents, "on" | "reload" | "loadURL" | "forcefullyCrashRenderer" | "isDestroyed">;

/** A question for the user about the window, answered with the index of the button they chose. */
export interface WindowPrompt {
  readonly message: string;
  readonly detail: string;
  readonly buttons: ReadonlyArray<string>;
  /** Closes the question unanswered, as when the page responds again. */
  readonly signal?: AbortSignal;
}

export interface RecoveryOptions {
  readonly page: WatchedPage;
  readonly ask: (prompt: WindowPrompt) => Promise<number>;
  readonly close: () => void;
  readonly log?: (message: string, details: unknown) => void;
  readonly later?: (ms: number, run: () => void) => void;
  readonly now?: () => number;
}

/** Crashes within this long of each other count as one run of crashes. */
const CRASH_WINDOW_MS = 60_000;
/** A page that crashes this often in a row, or fails to load this often in a row, asks the user. */
const MAX_TRIES = 3;
/** How long a page that failed to load waits before it is tried again. */
const RETRY_MS = 2000;
/** Chromium's code for a load that was stopped, as by a refused navigation: nothing failed. */
const ERR_ABORTED = -3;

export const watchWindow = ({
  page,
  ask,
  close,
  log = (message, details) => console.error(message, details),
  later = (ms, run) => void setTimeout(run, ms),
  now = Date.now,
}: RecoveryOptions) => {
  let crashes: Array<number> = [];
  let failedLoads = 0;
  let hung: AbortController | undefined;
  /** At most one question about a crash or a failed load at a time. */
  let asking = false;
  const askOnce = (prompt: WindowPrompt, then: (choice: number) => void) => {
    if (asking) return;
    asking = true;
    void ask(prompt).then((choice) => {
      asking = false;
      if (!page.isDestroyed()) then(choice);
    });
  };

  const live = () => !page.isDestroyed();

  page.on("render-process-gone", (_event: unknown, details: { readonly reason: string; readonly exitCode: number }) => {
    log("A Hobbots window's page stopped", details);
    hung?.abort();
    hung = undefined;
    const at = now();
    crashes = [...crashes.filter((crash) => at - crash < CRASH_WINDOW_MS), at];
    if (crashes.length < MAX_TRIES) {
      if (live()) page.reload();
      return;
    }
    askOnce({ message: copy.stopped, detail: copy.stoppedDetail, buttons: [copy.reload, copy.close] }, (choice) => {
      crashes = [];
      if (choice === 0) page.reload();
      else close();
    });
  });

  page.on("unresponsive", () => {
    log("A Hobbots window's page is not responding", {});
    if (hung !== undefined) return;
    const controller = new AbortController();
    hung = controller;
    void ask({
      message: copy.notResponding,
      detail: copy.notRespondingDetail,
      buttons: [copy.wait, copy.reload],
      signal: controller.signal,
    }).then((choice) => {
      if (hung === controller) hung = undefined;
      // Its page then stops and loads again, as after any crash.
      if (!controller.signal.aborted && choice === 1 && live()) page.forcefullyCrashRenderer();
    });
  });

  page.on("responsive", () => {
    hung?.abort();
    hung = undefined;
  });

  page.on("did-finish-load", () => {
    failedLoads = 0;
  });

  page.on("did-fail-load", (_event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => {
    if (!isMainFrame || code === ERR_ABORTED) return;
    log("A Hobbots window's page did not load", { code, description, url });
    failedLoads += 1;
    if (failedLoads < MAX_TRIES) {
      later(RETRY_MS, () => {
        if (live()) void page.loadURL(url).catch(() => undefined);
      });
      return;
    }
    askOnce(
      { message: copy.notLoaded, detail: copy.notLoadedDetail, buttons: [copy.tryAgain, copy.close] },
      (choice) => {
        failedLoads = 0;
        if (choice === 0) void page.loadURL(url).catch(() => undefined);
        else close();
      },
    );
  });
};
