import { Effect, Stream } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

/** What a tool printed on its standard output, and its exit code. */
export interface ToolRun {
  readonly out: string;
  readonly code: number;
}

/** The environment a hub tool runs with: where it finds its config and the keychain, and nothing a hob set. */
export const toolEnv = (
  env: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): Record<string, string | undefined> => ({
  PATH: env.PATH,
  HOME: env.HOME,
  USER: env.USER,
  XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
  // The Secret Service, and the keyrings `gh` and Git's helpers use on Linux, are reached over the session bus.
  DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS,
  XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR,
  ...extra,
});

/**
 * Runs a tool on the hub, never in the sandbox, with `input` on its standard input, so a secret
 * never goes on a command line. Fails when the tool cannot start or takes longer than 15 seconds.
 */
export const runTool =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"], env: Record<string, string | undefined>) =>
  (
    command: string,
    args: ReadonlyArray<string>,
    options: { readonly input?: string; readonly cwd?: string } = {},
  ): Effect.Effect<ToolRun, "unavailable"> =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(command, args, {
            env,
            extendEnv: false,
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            stdin: options.input === undefined ? "ignore" : Stream.make(new TextEncoder().encode(options.input)),
          }),
        );
        const [out, code] = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(Stream.drainFork(handle.stdout, handle.stderr))), handle.exitCode],
          { concurrency: 2 },
        );
        return { out, code: Number(code) };
      }),
    ).pipe(
      Effect.timeout("15 seconds"),
      Effect.mapError(() => "unavailable" as const),
    );
