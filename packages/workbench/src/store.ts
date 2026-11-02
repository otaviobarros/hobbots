import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ActivityStore, ActivityStoreUnavailable } from "@hobbots/agents";
import { ContentId } from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { ownFile, realFolder } from "./own-files.ts";

/**
 * Keeps command logs and file contents for the Workbench (ADR 023) as files in `folder`, inside the
 * hub's data folder, which no hob can reach: one file per SHA-256 of what it holds, written already
 * redacted. A file is read back only when it is a regular file with one name that the hub's own
 * user owns, so a planted link or file is never served.
 */

const ID = /^[0-9a-f]{64}$/;

export const makeActivityStore = (folder: string) => {
  const fileOf = (id: string) => join(folder, id);

  const read = async (id: string): Promise<Uint8Array | null> => {
    if (!ID.test(id) || !(await realFolder(folder))) return null;
    const handle = await open(fileOf(id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
      () => null,
    );
    if (handle === null) return null;
    try {
      return ownFile(await handle.stat()) ? new Uint8Array(await handle.readFile()) : null;
    } finally {
      await handle.close();
    }
  };

  const exists = async (id: string) => {
    if (!ID.test(id) || !(await realFolder(folder))) return false;
    const stats = await lstat(fileOf(id)).catch(() => null);
    return stats !== null && ownFile(stats);
  };

  const write = async (bytes: Uint8Array) => {
    const id = createHash("sha256").update(bytes).digest("hex");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (!(await realFolder(folder))) throw new Error(`${folder} is not a folder`);
    if (await exists(id)) return { id: ContentId.make(id), added: false };
    // Written under a fresh name and renamed into place, so a reader never sees half of it.
    const temporary = join(folder, `.${id}.${crypto.randomUUID()}`);
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    await rename(temporary, fileOf(id));
    return { id: ContentId.make(id), added: true };
  };

  const list = async () => {
    if (!(await realFolder(folder))) return [];
    return (await readdir(folder)).filter((name) => ID.test(name)).map((name) => ContentId.make(name));
  };

  return ActivityStore.of({
    put: (bytes) =>
      Effect.tryPromise({
        try: () => write(bytes),
        catch: (cause) =>
          new ActivityStoreUnavailable({ message: cause instanceof Error ? cause.message : String(cause) }),
      }),
    has: (id) => Effect.promise(() => exists(id).catch(() => false)),
    get: (id) =>
      Effect.tryPromise(() => read(id)).pipe(
        Effect.map(Option.fromNullishOr),
        Effect.orElseSucceed(() => Option.none()),
      ),
    list: Effect.tryPromise(list).pipe(Effect.orElseSucceed(() => [])),
    remove: (ids) =>
      Effect.promise(() =>
        Promise.all(ids.filter((id) => ID.test(id)).map((id) => unlink(fileOf(id)).catch(() => undefined))),
      ).pipe(Effect.asVoid),
  });
};

/** The hub's store of Workbench details, in `folder`. */
export const ActivityStoreLive = (folder: string) => Layer.sync(ActivityStore, () => makeActivityStore(folder));
