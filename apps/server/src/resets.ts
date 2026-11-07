import { lstat, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { GitHubAccounts, HobbotsRepository, HobGitHubApps, RetiredHobGitHubApp } from "@hobbots/agents";
import { ResetRefused } from "@hobbots/api";
import { deleteOutcome, GitHubConnection, HobAppKeys, Keychain } from "@hobbots/charms";
import type { Agent } from "@hobbots/domain";
import { Context, Effect, Layer, Option } from "effect";
import { HUB_ENTRIES, removeTree } from "./backup-files.ts";
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
 * What the memory engine keeps in the data folder (ADR 028): ai-memory's own data folder and the
 * hub's keys for it. Start over deletes them with the rest; the engine stops with the hub first.
 */
const MEMORY_ENTRIES = ["memory", "memory-keys"] as const;

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
  // The skills library and each turn's skill folder are read-only (ADR 029): `removeTree` opens them first.
  for (const entry of [...HUB_ENTRIES, ...MEMORY_ENTRIES]) await removeTree(join(dataDir, entry));
  await removeTree(runtimeFolders(dataDir));
  for (const folder of await setAsideFolders(dataDir)) await removeTree(folder);
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
 * Deletes the keychain items of a hub with no hub running (#948), for the `reset` command: every
 * hob's GitHub App key and the GitHub sign-in. Answers what may still be in the keychain: an item the
 * keychain refused to delete, or one the hub's records say it stored whose delete had no answer.
 * The apps stay on GitHub with their installations: only a running hub can ask GitHub to remove those.
 */
export const eraseKeychain = (hobs: ReadonlyArray<Pick<Agent, "id" | "name">>) =>
  Effect.gen(function* () {
    const keys = yield* HobAppKeys;
    const signIn = yield* Keychain;
    const apps = yield* HobGitHubApps;
    const accounts = yield* GitHubAccounts;
    const kept: Array<string> = [];
    for (const hob of hobs) {
      const recorded = (yield* apps.get(hob.id)) !== null || (yield* apps.leftOver(hob.id)) !== null;
      const problem = yield* keys.remove(hob.id).pipe(
        Effect.as(null),
        Effect.catch((error) => Effect.succeed(deleteOutcome(error, recorded, `${hob.name}'s GitHub app key`))),
      );
      if (problem !== null) kept.push(problem);
    }
    const recorded = (yield* accounts.get) !== null;
    const problem = yield* signIn.remove.pipe(
      Effect.as(null),
      Effect.catch((error) => Effect.succeed(deleteOutcome(error, recorded, "the GitHub sign-in"))),
    );
    if (problem !== null) kept.push(problem);
    return kept;
  });

/** The words of a reset that stopped because the keychain kept items. */
export const keptReason = (kept: ReadonlyArray<string>) =>
  `Nothing was deleted, because sign-ins may still be in the keychain. ${kept.join(" ")} Unlock the keychain, check that it answers, and try again.`;

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
      // Answers what the keychain kept: nothing is deleted then, so the database keeps the record of
      // it and Start over can be tried again.
      const forgetSignIns = Effect.gen(function* () {
        const kept: Array<string> = [];
        if (Option.isSome(hobApps)) {
          for (const hob of yield* hobs.listAgentsWithStatus(["active", "paused", "retired"])) {
            const problem = yield* hobApps.value.erase(hob.id);
            if (problem !== null) kept.push(`${hob.name}: ${problem}`);
          }
        }
        if (Option.isSome(github)) {
          const problem = yield* github.value.erase;
          if (problem !== null) kept.push(problem);
        }
        return kept;
      });

      const start = Effect.gen(function* () {
        if (Option.isNone(restart)) {
          return yield* new ResetRefused({
            reason: "This hub cannot restart itself. Stop it and delete its data folder instead.",
          });
        }
        const kept = yield* forgetSignIns;
        if (kept.length > 0) {
          yield* Effect.logWarning("Start over stopped: the keychain kept sign-ins", { kept });
          return yield* new ResetRefused({ reason: keptReason(kept) });
        }
        yield* Effect.log("Starting over: the hub stops, deletes its data and starts again empty");
        // The answer leaves before the hub stops.
        yield* restart.value.reset.pipe(Effect.delay("300 millis"), Effect.forkDetach);
      });

      return HubReset.of({ start });
    }),
  );
}
