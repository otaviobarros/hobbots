import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { type ToolLogKey, ToolLogs, ToolLogUnavailable } from "@hobbots/agents";
import { Effect, Layer, Option } from "effect";

/**
 * A step's log file. The name is a digest of the step's ids, so no id a runtime or a request makes
 * up can name a path outside the folder.
 */
const logFile = (folder: string, key: ToolLogKey) =>
  join(folder, `${createHash("sha256").update(`${key.threadId}\0${key.messageId}\0${key.stepId}`).digest("hex")}.log`);

/**
 * Whether an open file is one this hub wrote: a regular file with one name, owned by the hub's
 * user. A link, a device or a file another user planted is never read.
 */
const ownFile = (stats: { isFile(): boolean; nlink: number; uid: number }) =>
  stats.isFile() && stats.nlink === 1 && (process.getuid === undefined || stats.uid === process.getuid());

/** The folder itself, never a link to somewhere else. */
const realFolder = async (folder: string) => {
  const stats = await lstat(folder);
  return stats.isDirectory() && !stats.isSymbolicLink();
};

const write = async (folder: string, key: ToolLogKey, text: string) => {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if (!(await realFolder(folder))) throw new Error(`${folder} is not a folder`);
  // O_NOFOLLOW: a link planted at the file's name fails the open instead of being written through.
  const handle = await open(
    logFile(folder, key),
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!ownFile(await handle.stat())) throw new Error("the log's name is taken by another file");
    await handle.writeFile(text, "utf8");
  } finally {
    await handle.close();
  }
};

const read = async (folder: string, key: ToolLogKey): Promise<string | undefined> => {
  if (!(await realFolder(folder))) return undefined;
  const handle = await open(logFile(folder, key), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return ownFile(await handle.stat()) ? await handle.readFile("utf8") : undefined;
  } finally {
    await handle.close();
  }
};

/**
 * Keeps tool steps' full logs as files in `folder`, inside the hub's data folder, which no hob can
 * reach. Logs are written already redacted and read back only through the step that names them.
 */
export const ToolLogsLive = (folder: string) =>
  Layer.succeed(ToolLogs, {
    write: (key, text) =>
      Effect.tryPromise({
        try: () => write(folder, key, text),
        catch: (cause) => new ToolLogUnavailable({ message: cause instanceof Error ? cause.message : String(cause) }),
      }),
    // A log that is missing, or is not a file this hub wrote, reads as none.
    read: (key) =>
      Effect.tryPromise(() => read(folder, key)).pipe(
        Effect.map(Option.fromUndefinedOr),
        Effect.orElseSucceed(() => Option.none()),
      ),
  });
