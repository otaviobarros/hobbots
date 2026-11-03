import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { DataExport, ExportFolders } from "@hobbots/agents";
import { ExportFailed, HobbotsApi } from "@hobbots/api";
import { uniqueName } from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { defaultSaveFolder } from "./destination.ts";

/** Exports (ADR 026) are written owner-only: folders `0700`, files `0600`, as backups are. */
const FOLDER_MODE = 0o700;
const FILE_MODE = 0o600;

/** How many `name (n)` spellings `create` tries before it gives up. */
const MAX_TRIES = 100;

const failed = (message: string) => () => new ExportFailed({ message });

/** `path` inside `folder`, or none when it is absolute or climbs out of it. */
const inside = (folder: string, path: string): Option.Option<string> => {
  const relative = normalize(path);
  return isAbsolute(relative) || relative === ".." || relative.startsWith(`..${sep}`)
    ? Option.none()
    : Option.some(join(folder, relative));
};

const makeFolder = (parent: string, name: string) =>
  Effect.gen(function* () {
    const taken = new Set<string>();
    for (let tries = 0; tries < MAX_TRIES; tries += 1) {
      const folder = join(parent, uniqueName(taken, name));
      const made = yield* Effect.tryPromise({
        try: () => mkdir(folder, { mode: FOLDER_MODE }).then(() => true),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          (cause as NodeJS.ErrnoException).code === "EEXIST"
            ? Effect.succeed(false)
            : Effect.fail(new ExportFailed({ message: `Hobbots could not make a folder in ${parent}` })),
        ),
      );
      if (made) return folder;
    }
    return yield* new ExportFailed({ message: `${parent} already holds too many exports named ${name}` });
  });

/** Export folders on the hub's own filesystem. A file is never written over one that is there. */
export const ExportFoldersLive = Layer.succeed(
  ExportFolders,
  ExportFolders.of({
    create: makeFolder,
    write: (folder, path, contents) =>
      Option.match(inside(folder, path), {
        onNone: () => Effect.fail(new ExportFailed({ message: `${path} is not a path inside the export` })),
        onSome: (target) =>
          Effect.tryPromise({
            try: async () => {
              await mkdir(dirname(target), { recursive: true, mode: FOLDER_MODE });
              await writeFile(target, contents, { flag: "wx", mode: FILE_MODE });
            },
            catch: failed(`Hobbots could not write ${path} in ${folder}`),
          }),
      }),
    remove: (folder) => Effect.promise(() => rm(folder, { recursive: true, force: true }).catch(() => undefined)),
  }),
);

/** Exports over HTTP. A hub without the export service, as in tests that do not need it, refuses them. */
export const ExportsHandlers = HttpApiBuilder.group(HobbotsApi, "exports", (handlers) =>
  Effect.gen(function* () {
    const exporter = yield* Effect.serviceOption(DataExport);
    return handlers.handleAll({
      destination: () => Effect.sync(() => ({ folder: defaultSaveFolder() })),
      create: ({ payload }) =>
        Option.match(exporter, {
          onNone: () => Effect.fail(new ExportFailed({ message: "This hub does not make exports" })),
          onSome: (service) => service.run(payload.scope, payload.destination),
        }),
    });
  }),
);
