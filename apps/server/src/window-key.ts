import { join } from "node:path";

/**
 * The file in the data folder that holds this start's window key (ADR 021). Only the user can read
 * it; the desktop app reads it for its window, and the allow command to act as the window.
 */
export const windowKeyFile = (dataDir: string) => join(dataDir, "window-key");
