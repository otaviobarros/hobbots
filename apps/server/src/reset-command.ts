import { existsSync } from "node:fs";
import { join } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { GitHubAccounts, HobbotsRepository, HobGitHubApps } from "@hobbots/agents";
import { HobAppKeysLive, hubKeychainScope, KeychainLive, LegacyKeychainLive } from "@hobbots/charms";
import {
  GitHubAccountRepository,
  HobbotsRepositoryLive,
  HobGitHubAppRepository,
  SqliteLive,
} from "@hobbots/persistence";
import { Console, Effect, Layer } from "effect";
import { exitOnFailure, freeDataFolder } from "./command-line.ts";
import { ServerConfig } from "./config.ts";
import { legacyKeychainLock } from "./legacy-keychain.ts";
import { forgetKeychain, keptReason, wipeHubData } from "./resets.ts";

const hubDatabase = (dataDir: string) => join(dataDir, "hobbots.sqlite");

/**
 * The hub's records of its hobs and their GitHub apps and account, read from its database. With no
 * database there are no hobs, and no record that anything was stored in the keychain.
 */
const recordsOf = (dataDir: string) =>
  existsSync(hubDatabase(dataDir))
    ? Layer.mergeAll(HobbotsRepositoryLive, HobGitHubAppRepository, GitHubAccountRepository).pipe(
        Layer.provide(SqliteLive(hubDatabase(dataDir))),
      )
    : Layer.mergeAll(
        Layer.succeed(HobbotsRepository, {
          listAgentsWithStatus: () => Effect.succeed([]),
        } as unknown as HobbotsRepository["Service"]),
        Layer.succeed(HobGitHubApps, {
          get: () => Effect.succeed(null),
          leftOver: () => Effect.succeed(null),
        } as unknown as HobGitHubApps["Service"]),
        Layer.succeed(GitHubAccounts, { get: Effect.succeed(null) } as unknown as GitHubAccounts["Service"]),
      );

/**
 * Starts a hub with no app over (#948): `pnpm --filter @hobbots/server reset` says what it deletes,
 * and with `--yes` deletes every hob's GitHub App key and the GitHub sign-in from the keychain, then
 * everything the hub keeps in its data folder, as Settings › Your data › Start over does. It refuses
 * while a hub is using the folder, and deletes nothing when the keychain keeps an item.
 */
const reset = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const confirmed = process.argv.slice(2).includes("--yes");
  const dataDir = yield* freeDataFolder(config.dataDir, "start over from its Settings");
  // Only this hub's own items (#1214): other hubs on the computer keep their sign-ins.
  const scope = hubKeychainScope(dataDir);
  const keychains = Layer.mergeAll(
    KeychainLive(process.platform, process.env, scope),
    HobAppKeysLive(process.platform, process.env, scope),
    LegacyKeychainLive(process.platform, process.env),
  ).pipe(Layer.provide(NodeServices.layer));
  const kept = yield* Effect.gen(function* () {
    const hobs = yield* Effect.flatMap(HobbotsRepository, (repo) =>
      repo.listAgentsWithStatus(["active", "paused", "retired"]),
    );
    yield* Console.log(`Deletes every hob (${hobs.length}), chat, Quest, setting and device of the hub in ${dataDir},`);
    yield* Console.log("its runtimes folder, and the GitHub sign-in and hobs' GitHub app keys in the keychain.");
    yield* Console.log("Your folders, backups saved elsewhere and your runtime accounts stay. It cannot be undone.");
    if (!confirmed) return null;
    // A hub that never started since #1214 still has its sign-ins in the items every hub shared.
    return yield* forgetKeychain(hobs, legacyKeychainLock());
  }).pipe(
    Effect.provide(Layer.mergeAll(recordsOf(dataDir), keychains)),
    Effect.mapError(() => `The hub's database in ${dataDir} could not be read, so what it stored is not known.`),
  );
  if (kept === null) return yield* Console.log("Run again with --yes to delete everything.");
  if (kept.length > 0) return yield* Effect.fail(keptReason(kept));
  yield* Effect.promise(() => wipeHubData(dataDir));
  yield* Console.log(`Deleted. The hub's next start in ${dataDir} begins at First run.`);
}).pipe(exitOnFailure);

NodeRuntime.runMain(reset);
