import { accessSync, constants, mkdirSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { FolderSandbox, SandboxUnavailable } from "@hobbots/agents";
import { Effect, Layer } from "effect";
import { ProcessSandbox, shellQuote } from "./sandbox.ts";

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

/**
 * Charm reads of a hob's folders in the hub's OS sandbox (ADR 020): the folders are readable and
 * nothing of the hob's is writable, no host is reachable, and the hub's credentials stay out of the
 * program's environment. The program's own state goes in `stateFolder`, which is the hub's.
 */
export const FolderSandboxLive = (options: { readonly dataFolder: string; readonly stateFolder: string }) =>
  Layer.effect(
    FolderSandbox,
    Effect.gen(function* () {
      const sandbox = yield* ProcessSandbox;
      return FolderSandbox.of({
        readOnly: (folders, program, args) =>
          Effect.gen(function* () {
            if (sandbox.state !== "on") {
              return yield* new SandboxUnavailable({
                message: `The sandbox cannot start on this hub (${sandbox.evidence}), so Hobbots cannot read your folder safely.`,
              });
            }
            const binary = onPath(program);
            if (binary === null) {
              return yield* new SandboxUnavailable({ message: `${program} is not installed on the hub.` });
            }
            mkdirSync(options.stateFolder, { recursive: true, mode: 0o700 });
            const prepared = yield* Effect.acquireRelease(
              sandbox.prepare({
                folders,
                folderAccess: { read: true, write: false },
                dataFolder: options.dataFolder,
                binary,
                runtimeFolder: options.stateFolder,
                allowedHosts: [],
                decideHost: async (host) => `${host} is never reached while Hobbots reads a folder.`,
              }),
              (prepared) => Effect.sync(prepared.release),
            ).pipe(Effect.mapError((error) => new SandboxUnavailable({ message: error.message })));
            // Its home is the hub's own folder, so no configuration of the user's is read from there.
            const spawn = prepared.spawnArgs(binary, args, { PATH: process.env.PATH, HOME: options.stateFolder });
            const env = Object.fromEntries(
              Object.entries(spawn.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
            );
            return { commandLine: [spawn.command, ...spawn.args].map(shellQuote).join(" "), env };
          }),
      });
    }),
  );
