import { accessSync, constants, mkdirSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { FolderSandbox, RepositorySandbox, type SandboxedProgram, SandboxUnavailable } from "@hobbots/agents";
import { GIT_INIT_SCRIPT } from "@hobbots/domain";
import { Effect, Layer, type Scope } from "effect";
import { ProcessSandbox, type ProcessSandboxShape, type SandboxScope, shellQuote } from "./sandbox.ts";

/** The program's absolute path on PATH, or null when it is not there. */
export const onPath = (program: string, path: string | undefined = process.env.PATH): string | null => {
  if (isAbsolute(program)) return program;
  for (const dir of (path ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, program);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
};

interface HubSandboxOptions {
  readonly dataFolder: string;
  readonly stateFolder: string;
}

/**
 * A program the hub runs for a Charm in its OS sandbox: no host is reachable, the hub's credentials
 * stay out of its environment, and its home is the hub's own `stateFolder`, so no configuration of
 * the user's is read from there. `scope` says what of the hob's it reaches.
 */
const sandboxedProgram = (
  sandbox: ProcessSandboxShape,
  options: HubSandboxOptions,
  scope: Pick<SandboxScope, "folders" | "folderAccess" | "gitUnprotected">,
  program: string,
  args: ReadonlyArray<string>,
  purpose: string,
): Effect.Effect<SandboxedProgram, SandboxUnavailable, Scope.Scope> =>
  Effect.gen(function* () {
    if (sandbox.state !== "on") {
      return yield* new SandboxUnavailable({
        message: `The sandbox cannot start on this hub (${sandbox.evidence}), so Hobbots cannot ${purpose} safely.`,
      });
    }
    const binary = onPath(program);
    if (binary === null) {
      return yield* new SandboxUnavailable({ message: `${program} is not installed on the hub.` });
    }
    mkdirSync(options.stateFolder, { recursive: true, mode: 0o700 });
    const prepared = yield* Effect.acquireRelease(
      sandbox.prepare({
        ...scope,
        dataFolder: options.dataFolder,
        binary,
        runtimeFolder: options.stateFolder,
        allowedHosts: [],
        decideHost: async (host) => `${host} is never reached while Hobbots works in a folder for a hob.`,
      }),
      (prepared) => Effect.sync(prepared.release),
    ).pipe(Effect.mapError((error) => new SandboxUnavailable({ message: error.message })));
    const spawn = prepared.spawnArgs(binary, args, { PATH: process.env.PATH, HOME: options.stateFolder });
    const env = Object.fromEntries(
      Object.entries(spawn.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    return { commandLine: [spawn.command, ...spawn.args].map(shellQuote).join(" "), env };
  });

/**
 * Charm reads of a hob's folders in the hub's OS sandbox (ADR 020): the folders are readable and
 * nothing of the hob's is writable, no host is reachable, and the hub's credentials stay out of the
 * program's environment. The program's own state goes in `stateFolder`, which is the hub's.
 */
export const FolderSandboxLive = (options: HubSandboxOptions) =>
  Layer.effect(
    FolderSandbox,
    Effect.map(ProcessSandbox, (sandbox) =>
      FolderSandbox.of({
        readOnly: (folders, program, args) =>
          sandboxedProgram(
            sandbox,
            options,
            { folders, folderAccess: { read: true, write: false } },
            program,
            args,
            "read your folder",
          ),
      }),
    ),
  );

/**
 * Creates a repository for a hob in the hub's OS sandbox (ADR 014, #578): the program can write only
 * below `writable`, where Git's files are not protected for it, and reach no host. Its home is the
 * hub's `stateFolder`, so the user's Git config, and any template it names, is never read.
 */
export const RepositorySandboxLive = (options: HubSandboxOptions) =>
  Layer.effect(
    RepositorySandbox,
    Effect.map(ProcessSandbox, (sandbox) =>
      RepositorySandbox.of({
        gitInit: (writable, folder, initialBranch) =>
          sandboxedProgram(
            sandbox,
            options,
            { folders: [writable], folderAccess: { read: true, write: true }, gitUnprotected: true },
            "sh",
            ["-c", GIT_INIT_SCRIPT, "sh", folder, initialBranch ?? ""],
            "create a repository in your folder",
          ),
      }),
    ),
  );
