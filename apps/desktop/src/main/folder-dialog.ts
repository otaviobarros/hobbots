import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, OpenDialogOptions } from "electron";

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
export const handleFolderDialogIpc = (options: {
  readonly ipcMain: Pick<IpcMain, "handle">;
  readonly isTrusted: (event: IpcMainInvokeEvent) => boolean;
  readonly windowOf: (event: IpcMainInvokeEvent) => BrowserWindow | null;
  readonly showOpenDialog: (
    window: BrowserWindow | null,
    options: OpenDialogOptions,
  ) => Promise<{ canceled: boolean; filePaths: ReadonlyArray<string> }>;
}) => {
  const { ipcMain, isTrusted, windowOf, showOpenDialog } = options;
  const dialogs: ReadonlyArray<readonly [string, OpenDialogOptions]> = [
    [folderDialogChannel, folderDialogOptions],
    [backupDialogChannels.save, backupDialogOptions.save],
    [backupDialogChannels.restore, backupDialogOptions.restore],
  ];
  for (const [channel, shown] of dialogs) {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent) => {
      if (!isTrusted(event)) throw new Error("Not allowed from this page");
      const result = await showOpenDialog(windowOf(event), shown);
      const [folder] = result.filePaths;
      return result.canceled || folder === undefined ? null : folder;
    });
  }
};
