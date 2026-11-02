import { Context, Effect, Layer, Option, Redacted, Ref, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { runTool, type ToolRun, toolEnv } from "./run-tool.ts";

/**
 * The OS keychain on the hub, where the connected GitHub account's tokens live (ADR 020). The
 * secret is handed to the keychain tool on its standard input, never on a command line, where any
 * process on the hub could read it. Without a usable keychain the hub refuses to keep a secret
 * rather than write it to a file.
 */

/** Why the keychain could not keep or give back a secret. */
export class KeychainError extends Schema.TaggedError<KeychainError>()("KeychainError", {
  reason: Schema.Literals(["unavailable", "failed"]),
  message: Schema.String,
}) {}

export class Keychain extends Context.Service<
  Keychain,
  {
    /** The stored secret, or none when there is no item. */
    readonly read: Effect.Effect<Option.Option<Redacted.Redacted<string>>, KeychainError>;
    /** Stores the secret, replacing any item already there. */
    readonly write: (secret: Redacted.Redacted<string>) => Effect.Effect<void, KeychainError>;
    /** Deletes the item; nothing happens when there is none. */
    readonly remove: Effect.Effect<void, KeychainError>;
  }
>()("@hobbots/charms/Keychain") {}

/** The item's service name in the keychain: one item, for the GitHub account the hub connected. */
export const KEYCHAIN_SERVICE = "ai.hobbots.github";
const KEYCHAIN_ACCOUNT = "github.com";

// A stored secret holds only these characters (base64url), so it needs no quoting on `security`'s input line.
const SAFE_SECRET = /^[A-Za-z0-9_-]+$/;

/** Runs a keychain tool on the hub; one that cannot run means the hub has no keychain. */
const runner = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"], env: NodeJS.ProcessEnv) => {
  const run = runTool(spawner, toolEnv(env));
  return (command: string, args: ReadonlyArray<string>, input?: string): Effect.Effect<ToolRun, KeychainError> =>
    run(command, args, input === undefined ? {} : { input }).pipe(
      Effect.mapError(
        () =>
          new KeychainError({
            reason: "unavailable",
            message: `The hub could not run ${command}, so it has no keychain to keep the GitHub sign-in in.`,
          }),
      ),
    );
};

const failed = (what: string, code: number) =>
  new KeychainError({ reason: "failed", message: `The keychain could not ${what} the GitHub sign-in (${code}).` });

const checkSafe = (secret: Redacted.Redacted<string>) =>
  SAFE_SECRET.test(Redacted.value(secret))
    ? Effect.void
    : Effect.fail(
        new KeychainError({ reason: "failed", message: "The GitHub sign-in is not in a form Hobbots stores." }),
      );

/**
 * macOS Keychain through `security`. Writing goes through `security -i`, which reads the command
 * from its standard input, so the secret never shows in the process list. Exit code 44 means no item.
 */
const macOS = (run: ReturnType<typeof runner>) => {
  const read = run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"]).pipe(
    Effect.flatMap(({ out, code }) =>
      code === 0
        ? Effect.succeed(Option.some(Redacted.make(out.trim())))
        : code === 44
          ? Effect.succeed(Option.none())
          : Effect.fail(failed("read", code)),
    ),
  );
  return Keychain.of({
    read,
    write: (secret) =>
      checkSafe(secret).pipe(
        Effect.andThen(
          run(
            "security",
            ["-i"],
            `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w ${Redacted.value(secret)}\n`,
          ),
        ),
        Effect.flatMap(({ code }) => (code === 0 ? Effect.void : Effect.fail(failed("save", code)))),
        // `security -i` can exit 0 when the command it read failed, so the item is read back.
        Effect.andThen(read),
        Effect.flatMap((saved) =>
          Option.isSome(saved) && Redacted.value(saved.value) === Redacted.value(secret)
            ? Effect.void
            : Effect.fail(failed("save", 0)),
        ),
      ),
    remove: run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT]).pipe(
      Effect.flatMap(({ code }) => (code === 0 || code === 44 ? Effect.void : Effect.fail(failed("delete", code)))),
    ),
  });
};

/**
 * The Secret Service on Linux through `secret-tool`, which reads the secret to store from its
 * standard input. A lookup with no item prints nothing and exits 1.
 */
const secretService = (run: ReturnType<typeof runner>) => {
  const attributes = ["service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT];
  return Keychain.of({
    read: run("secret-tool", ["lookup", ...attributes]).pipe(
      Effect.flatMap(({ out, code }) =>
        code === 0 && out.trim() !== ""
          ? Effect.succeed(Option.some(Redacted.make(out.trim())))
          : code === 0 || code === 1
            ? Effect.succeed(Option.none())
            : Effect.fail(failed("read", code)),
      ),
    ),
    write: (secret) =>
      checkSafe(secret).pipe(
        Effect.andThen(run("secret-tool", ["store", "--label=Hobbots GitHub", ...attributes], Redacted.value(secret))),
        Effect.flatMap(({ code }) =>
          code === 0
            ? Effect.void
            : Effect.fail(
                new KeychainError({
                  reason: "unavailable",
                  message: "The Secret Service on this hub could not save the GitHub sign-in. Is a keyring unlocked?",
                }),
              ),
        ),
      ),
    remove: run("secret-tool", ["clear", ...attributes]).pipe(
      Effect.flatMap(({ code }) => (code === 0 || code === 1 ? Effect.void : Effect.fail(failed("delete", code)))),
    ),
  });
};

const noKeychain = new KeychainError({
  reason: "unavailable",
  message: "This hub has no keychain Hobbots can use, so it does not keep a GitHub sign-in.",
});

/** The keychain of the hub's platform: macOS Keychain, the Secret Service on Linux, else none. */
export const KeychainLive = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv) =>
  Layer.effect(
    Keychain,
    Effect.gen(function* () {
      const run = runner(yield* ChildProcessSpawner.ChildProcessSpawner, env);
      if (platform === "darwin") return macOS(run);
      if (platform === "linux") return secretService(run);
      return Keychain.of({
        read: Effect.succeed(Option.none()),
        write: () => Effect.fail(noKeychain),
        remove: Effect.void,
      });
    }),
  );

/**
 * A keychain held in memory for the hub's lifetime, for tests and for a hub started with
 * `HOBBOTS_FAKE_KEYCHAIN=memory` to try the flow without touching the real keychain.
 */
export const KeychainMemory = Layer.effect(
  Keychain,
  Effect.gen(function* () {
    const item = yield* Ref.make(Option.none<Redacted.Redacted<string>>());
    return Keychain.of({
      read: Ref.get(item),
      write: (secret) => checkSafe(secret).pipe(Effect.andThen(Ref.set(item, Option.some(secret)))),
      remove: Ref.set(item, Option.none()),
    });
  }),
);
