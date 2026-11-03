/**
 * The argument the main process gives a connected desktop's window, so its preload offers the
 * narrower bridge (ADR 025). The window's pages cannot set it.
 */
export const CONNECTED_MODE_ARGUMENT = "--hobbots-connected-desktop";

/**
 * The argument the main process gives the window of a computer that has not chosen yet, so its
 * preload offers only setup's own calls (ADR 025). The local pages cannot set it.
 */
export const SETUP_MODE_ARGUMENT = "--hobbots-setup";
