import { handleTrusted, noArgs, type TrustedIpcOptions } from "./trusted-ipc.ts";

/** The one channel the preload bridge calls to show the memory engine's pages in Finder. */
export const showMemoryChannel = "hobbots:memory:show";

/**
 * Opens the folder of memory pages in Finder (ADR 028). The page sends nothing: the folder is the
 * one in the hub's data folder, which this app started the hub with, and only while it is a real
 * folder, not a link. Answers whether it was opened.
 */
export const handleShowMemoryIpc = (
  options: TrustedIpcOptions & {
    /** Where the memory engine keeps its pages as markdown: `memory/wiki` in the hub's data folder. */
    readonly folder: string;
    /** Whether `path` is a folder now, reached without following a link at its name. */
    readonly isFolder: (path: string) => Promise<boolean>;
    /** Opens a folder in Finder; answers an error message, or "" when it opened. */
    readonly openPath: (path: string) => Promise<string>;
  },
) => {
  const { folder, isFolder, openPath } = options;
  return handleTrusted(options, {
    [showMemoryChannel]: noArgs(async () => {
      if (!(await isFolder(folder).catch(() => false))) return false;
      return (await openPath(folder)) === "";
    }),
  });
};
