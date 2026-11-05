import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { HobbotsRepository } from "@hobbots/agents";
import { HobAppKeysLive, KeychainLive } from "@hobbots/charms";
import { HobbotsRepositoryLive, SqliteLive } from "@hobbots/persistence";
import { Console, Effect, Layer } from "effect";
import { exitOnFailure, hubRunning } from "./command-line.ts";
import { ServerConfig } from "./config.ts";
import { eraseKeychain, keptReason, wipeHubData } from "./resets.ts";

/** The hobs of the hub's database, retired ones too, or none when it has no database. */
const hobsOf = (dataDir: string) => {
  const database = join(dataDir, "hobbots.sqlite");
  if (!existsSync(database)) return Effect.succeed([]);
  return Effect.flatMap(HobbotsRepository, (repo) => repo.listAgentsWithStatus(["active", "paused", "retired"])).pipe(
    Effect.provide(HobbotsRepositoryLive.pipe(Layer.provide(SqliteLive(database)))),
    Effect.mapError(() => `The hub's database in ${dataDir} could not be read, so its hobs' keys are not known.`),
  );
};

/**
 * Starts a hub with no app over (#948): `pnpm --filter @hobbots/server reset` says what it deletes,
 * and with `--yes` deletes every hob's GitHub App key and the GitHub sign-in from the keychain, then
 * everything the hub keeps in its data folder, as Settings › Your data › Start over does. It refuses
 * while a hub is using the folder, and deletes nothing when the keychain keeps an item.
 */
const reset = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const confirmed = process.argv.slice(2).includes("--yes");
  mkdirSync(config.dataDir, { recursive: true });
  const dataDir = realpathSync(config.dataDir);
  if (yield* hubRunning(dataDir)) {
    return yield* Effect.fail(`A hub is using ${dataDir}. Stop it first, or start over from its Settings.`);
  }
  const hobs = yield* hobsOf(dataDir);
  yield* Console.log(`Deletes every hob (${hobs.length}), chat, Quest, setting and device of the hub in ${dataDir},`);
  yield* Console.log("its runtimes folder, and the GitHub sign-in and hobs' GitHub app keys in the keychain.");
  yield* Console.log("Your folders, backups saved elsewhere and your runtime accounts stay. It cannot be undone.");
  if (!confirmed) return yield* Console.log("Run again with --yes to delete everything.");
  const kept = yield* eraseKeychain(hobs);
  if (kept.length > 0) return yield* Effect.fail(keptReason(kept));
  yield* Effect.promise(() => wipeHubData(dataDir));
  yield* Console.log(`Deleted. The hub's next start in ${dataDir} begins at First run.`);
}).pipe(
  Effect.provide(
    Layer.mergeAll(KeychainLive(process.platform, process.env), HobAppKeysLive(process.platform, process.env)).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
  exitOnFailure,
);

NodeRuntime.runMain(reset);
