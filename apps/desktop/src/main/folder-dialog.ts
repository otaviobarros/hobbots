import type { BrowserWindow, IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import { handleTrusted, noArgs, type TrustedIpcOptions } from "./trusted-ipc.ts";

/** The one channel the preload bridge calls to pick a folder for hobs. */
export const folderDialogChannel = "hobbots:folder-dialog:choose";

/** What the dialog shows; the page cannot change it, so the bridge only ever picks folders. */
export const folderDialogOptions: OpenDialogOptions = {
  title: "Choose a folder for your hobs",
  buttonLabel: "Let hobs work here",
  properties: ["openDirectory", "createDirectory"],
};

/** The channels that pick a folder for a backup (ADR 026): where to save one, and which one to restore. */
export const backupDialogChannels = {
  save: "hobbots:folder-dialog:backup-save",
  restore: "hobbots:folder-dialog:backup-restore",
} as const;

export const backupDialogOptions: Record<keyof typeof backupDialogChannels, OpenDialogOptions> = {
  save: {
    title: "Choose where to save the backup",
    buttonLabel: "Save the backup here",
    properties: ["openDirectory", "createDirectory"],
  },
  // A backup is a folder; macOS shows its name ending in .hobbots-backup.
  restore: {
    title: "Choose a Hobbots backup",
    buttonLabel: "Restore this backup",
    properties: ["openDirectory"],
  },
};

/**
 * Answers the bridge with the folder the user picked, or null when they cancelled. Each call takes
 * no arguments, answers only pages the window is allowed to show, and returns a path the user chose
 * in the system dialog; the hub checks the folder again before it uses it.
 */
export const handleFolderDialogIpc = (
  options: TrustedIpcOptions & {
    readonly windowOf: (event: IpcMainInvokeEvent) => BrowserWindow | null;
    readonly showOpenDialog: (
      window: BrowserWindow | null,
      options: OpenDialogOptions,
    ) => Promise<{ canceled: boolean; filePaths: ReadonlyArray<string> }>;
  },
) => {
  const { windowOf, showOpenDialog } = options;
  const choose = (shown: OpenDialogOptions) =>
    noArgs(async (event) => {
      const result = await showOpenDialog(windowOf(event), shown);
      const [folder] = result.filePaths;
      return result.canceled || folder === undefined ? null : folder;
    });
  return handleTrusted(options, {
    [folderDialogChannel]: choose(folderDialogOptions),
    [backupDialogChannels.save]: choose(backupDialogOptions.save),
    [backupDialogChannels.restore]: choose(backupDialogOptions.restore),
  });
};
