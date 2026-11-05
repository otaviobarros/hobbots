import { Console, Effect } from "effect";
import { parseServerIdentity, readInstallationId } from "./installation.ts";
import { hubPort } from "./network-settings.ts";

/** Whether a hub of this data folder answers on its port, so a command must not touch the folder. */
export const hubRunning = (dataDir: string) =>
  Effect.promise(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${hubPort(dataDir, process.env)}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      const identity = parseServerIdentity(await response.json());
      return identity !== undefined && identity.installationId === readInstallationId(dataDir);
    } catch {
      return false;
    }
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
