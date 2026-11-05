import { mkdirSync, realpathSync } from "node:fs";
import { Console, Effect } from "effect";
import { hubPresenceFile, processAlive, readHubPresence } from "./hub-presence.ts";
import { parseServerIdentity, readInstallationId } from "./installation.ts";
import { hubPort } from "./network-settings.ts";

/** How long a hub that keeps no presence file may take to answer before the check gives up. */
const HEALTH_TIMEOUT_MS = 3000;

/** Whether nothing answered on the port at all, so no hub listens there. */
const refused = (error: unknown) =>
  error instanceof Error && (error.cause as NodeJS.ErrnoException | undefined)?.code === "ECONNREFUSED";

/**
 * Whether a hub may be using this data folder, so a command must not touch it (#999). A hub records
 * its process in the folder while it runs, so it is found whatever port it listens on. With no live
 * record, as for a hub of an earlier version, the hub's port is asked: only a refused connection or
 * a whole answer from another installation counts as no hub. Anything else counts as one: a port that
 * does not answer, or not in full, and an answer that does not say which hub it is.
 * Answers the reason to refuse, or undefined when no hub uses the folder.
 */
export const hubUsing = (dataDir: string) =>
  Effect.promise(async (): Promise<string | undefined> => {
    const presence = readHubPresence(dataDir);
    if (presence !== undefined && processAlive(presence.pid)) {
      return `A hub is using ${dataDir} (process ${presence.pid}, port ${presence.port}). If none is running, delete ${hubPresenceFile(dataDir)}.`;
    }
    const port = hubPort(dataDir, process.env);
    let body: unknown;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      body = await response.json();
    } catch (error) {
      return refused(error) ? undefined : `Port ${port} did not answer in full, so a hub may be using ${dataDir}.`;
    }
    const identity = parseServerIdentity(body);
    if (identity === undefined) return `Port ${port} did not say which hub it is, so a hub may be using ${dataDir}.`;
    return identity.installationId === readInstallationId(dataDir)
      ? `A hub is using ${dataDir} on port ${port}.`
      : undefined;
  });

/**
 * The data folder by its canonical path, made if it is missing, for a command that changes it. Fails
 * with why, ending in `advice` on what to do instead, while a hub may be using it.
 */
export const freeDataFolder = (folder: string, advice: string) =>
  Effect.gen(function* () {
    mkdirSync(folder, { recursive: true });
    const dataDir = realpathSync(folder);
    const using = yield* hubUsing(dataDir);
    if (using !== undefined) return yield* Effect.fail(`${using} Stop it first, or ${advice}. Nothing changed.`);
    return dataDir;
  });

/**
 * Ends a command-line tool of the hub on its failure: prints the reason and exits with status 1,
 * as the `allow`, `restore` and `reset` commands do.
 */
export const exitOnFailure = <A, R>(command: Effect.Effect<A, unknown, R>) =>
  command.pipe(
    Effect.catch((error) =>
      Console.error(typeof error === "string" ? error : String(error)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
    ),
  );
