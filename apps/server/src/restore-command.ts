import { mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { exitOnFailure } from "./command-line.ts";
import { ServerConfig } from "./config.ts";
import { parseServerIdentity, readInstallationId } from "./installation.ts";
import { hubPort } from "./network-settings.ts";
import { checkBackup, performRestore, summaryOf } from "./restores.ts";

/** Whether a hub of this data folder answers on its port. */
const hubRunning = (dataDir: string) =>
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
 * Restores a backup into the data folder of a hub with no app (ADR 026):
 * `pnpm --filter @hobbots/server restore <backup folder>` shows what the backup holds, and with
 * `--yes` restores it. It refuses while a hub is using the folder; the hub's next start applies the
 * rules of a restore, and holds work until you resume it in Settings.
 */
const restore = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const args = process.argv.slice(2);
  const confirmed = args.includes("--yes");
  const path = args.find((arg) => arg !== "--yes");
  if (path === undefined) return yield* Effect.fail("Name the backup folder: restore <backup folder> [--yes]");
  mkdirSync(config.dataDir, { recursive: true });
  const dataDir = realpathSync(config.dataDir);
  if (yield* hubRunning(dataDir)) {
    return yield* Effect.fail(`A hub is using ${dataDir}. Stop it first, or restore from its Settings.`);
  }
  const backup = resolve(path);
  const manifest = yield* checkBackup(backup).pipe(Effect.mapError((refused) => refused.reason));
  const summary = yield* summaryOf(backup, manifest);
  yield* Console.log(`Backup made ${summary.createdAt} by Hobbots ${summary.hobbotsVersion}`);
  yield* Console.log(
    `${summary.hobs} hobs, ${summary.threads} threads, ${summary.quests} Quests and ${summary.tasks} Tasks`,
  );
  for (const folder of summary.missingFolders) yield* Console.log(`Not on this computer: ${folder}`);
  yield* Console.log("Devices, keychain items and runtime sign-ins do not come back. Pair devices and sign in again.");
  if (!confirmed) return yield* Console.log(`Run again with --yes to restore it into ${dataDir}.`);
  const setAside = yield* performRestore(dataDir, backup).pipe(Effect.mapError((refused) => refused.reason));
  yield* Console.log(
    setAside === null
      ? `Restored into ${dataDir}.`
      : `Restored into ${dataDir}. The earlier data is in ${setAside} until you delete it.`,
  );
}).pipe(exitOnFailure);

NodeRuntime.runMain(restore);
