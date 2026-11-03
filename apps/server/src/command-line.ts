import { Console, Effect } from "effect";

/**
 * Ends a command-line tool of the hub on its failure: prints the reason and exits with status 1,
 * as the `allow` and `restore` commands do.
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
