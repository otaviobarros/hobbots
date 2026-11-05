import { lstat, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { HobbotsRepository, RetiredHobGitHubApp } from "@hobbots/agents";
import { ResetRefused } from "@hobbots/api";
import { GitHubConnection } from "@hobbots/charms";
import { Context, Effect, Layer, Option } from "effect";
import { HUB_ENTRIES } from "./backup-files.ts";
import { HubRestart } from "./restores.ts";
import { runtimeFolders } from "./tools.ts";

/**
 * The file Start over writes before it deletes anything (#948). While it is there, the reset has not
 * finished, and the hub's next start finishes it before it reads any data.
 */
export const resetMarkerFile = (dataDir: string) => join(dataDir, "reset.json");

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/**
 * The folders a restore set aside beside this data folder (ADR 026): copies of the hub's data that
 * Start over deletes too. Only folders named `<data folder>.before-restore-<date>`.
 */
const setAsideFolders = async (dataDir: string) => {
  const prefix = `${basename(dataDir)}.before-restore-`;
  const siblings = await readdir(dirname(dataDir)).catch(() => [] as Array<string>);
  return siblings.filter((name) => name.startsWith(prefix)).map((name) => join(dirname(dataDir), name));
};

/**
 * Deletes everything the hub keeps on this computer, with no hub running there (#948): its own
 * entries in the data folder, the runtimes folder beside it and the folders a restore set aside. The
 * desktop app's own files in the same folder stay, and so do the folders hobs work in. The marker is
 * written first and deleted last, so a reset that stops halfway is finished by `finishReset`.
 */
export const wipeHubData = async (dataDir: string) => {
  const marker = resetMarkerFile(dataDir);
  await writeFile(marker, `${JSON.stringify({ startedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  for (const entry of HUB_ENTRIES) await rm(join(dataDir, entry), { recursive: true, force: true });
  await rm(runtimeFolders(dataDir), { recursive: true, force: true });
  for (const folder of await setAsideFolders(dataDir)) await rm(folder, { recursive: true, force: true });
  await rm(marker, { force: true });
};

/**
 * Finishes a reset the last process started and did not finish, before the hub reads its data. A
 * data folder without the marker is left as it is. Returns whether there was one to finish.
 */
export const finishReset = async (dataDir: string) => {
  if (!(await exists(resetMarkerFile(dataDir)))) return false;
  await wipeHubData(dataDir);
  return true;
};

/**
 * Settings › Your data › Start over (#948): forgets the sign-ins the hub keeps in the OS keychain,
 * then stops the hub, which deletes its data and starts again empty, at First run. Deleting the
 * database signs out every device and ends every running reply.
 */
export class HubReset extends Context.Service<HubReset, { readonly start: Effect.Effect<void, ResetRefused> }>()(
  "@hobbots/server/HubReset",
) {
  static readonly layer = Layer.effect(
    HubReset,
    Effect.gen(function* () {
      const restart = yield* Effect.serviceOption(HubRestart);
      const hobs = yield* HobbotsRepository;
      const github = yield* Effect.serviceOption(GitHubConnection);
      const hobApps = yield* Effect.serviceOption(RetiredHobGitHubApp);

      // The keychain is outside the data folder, so its items go while the services that own them
      // still run. A hob's own GitHub app also loses its installations, as when the hob retires.
      const forgetSignIns = Effect.gen(function* () {
        if (Option.isSome(hobApps)) {
          for (const hob of yield* hobs.listAgentsWithStatus(["active", "paused", "retired"])) {
            yield* hobApps.value.remove(hob.id);
          }
        }
        if (Option.isSome(github)) yield* github.value.disconnect;
      });

      const start = Effect.gen(function* () {
        if (Option.isNone(restart)) {
          return yield* new ResetRefused({
            reason: "This hub cannot restart itself. Stop it and delete its data folder instead.",
          });
        }
        yield* forgetSignIns;
        yield* Effect.log("Starting over: the hub stops, deletes its data and starts again empty");
        // The answer leaves before the hub stops.
        yield* restart.value.reset.pipe(Effect.delay("300 millis"), Effect.forkDetach);
      });

      return HubReset.of({ start });
    }),
  );
}
