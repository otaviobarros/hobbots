import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { NodeRuntime } from "@effect/platform-node";
import {
  keepsThreadMarker,
  onDatabaseFile,
  SqliteLive,
  type ThreadUnread,
  unreadByMember,
  unreadByThreadMarker,
} from "@hobbots/persistence";
import { Console, Effect } from "effect";
import { exitOnFailure, freeDataFolder } from "./command-line.ts";
import { defaultDataDir } from "./config.ts";

// A dry run of migration 20261114004500 (ADR 039, read markers per member; #1454) on a copy of a hub's data
// folder: `pnpm --filter @hobbots/server member-reads <copy>` prints each thread's unread replies by
// the thread's own read marker, migrates the copy to this checkout's schema, and prints them again by
// the owner's member row. It exits with status 1 when any thread reads differently. It changes the
// copy's database, so it refuses the hub's own folder and one a hub is using.

const usage = "Give the folder of a copy of a hub's data folder: pnpm --filter @hobbots/server member-reads <copy>.";

const row = (cells: ReadonlyArray<string>, widths: ReadonlyArray<number>) =>
  cells.map((cell, index) => cell.slice(0, widths[index]).padEnd(widths[index] ?? 0)).join("  ");

const report = (before: ReadonlyArray<ThreadUnread>, after: ReadonlyArray<ThreadUnread>) =>
  Effect.gen(function* () {
    const afterOf = new Map(after.map((thread) => [thread.threadId, thread.unread]));
    const widths = [28, 36, 16, 6, 6];
    yield* Console.log(row(["Thread", "Title", "Hob", "Before", "After"], widths));
    let differ = 0;
    for (const thread of before) {
      const moved = afterOf.get(thread.threadId);
      if (moved !== thread.unread) differ += 1;
      const mark = moved === thread.unread ? "" : "  differs";
      yield* Console.log(
        `${row([thread.threadId, thread.title, thread.agentId, String(thread.unread), String(moved ?? "gone")], widths)}${mark}`,
      );
    }
    const sum = (threads: ReadonlyArray<ThreadUnread>) => threads.reduce((total, each) => total + each.unread, 0);
    const unreadThreads = (threads: ReadonlyArray<ThreadUnread>) => threads.filter((each) => each.unread > 0).length;
    yield* Console.log(
      `${before.length} threads. Before: ${sum(before)} unread replies in ${unreadThreads(before)} threads. ` +
        `After: ${sum(after)} unread replies in ${unreadThreads(after)} threads.`,
    );
    if (differ > 0 || after.length !== before.length) {
      return yield* Effect.fail(`${differ} threads read differently after the migration.`);
    }
    yield* Console.log("Every thread reads the same before and after.");
  });

const dryRun = Effect.gen(function* () {
  const folder = process.argv[2];
  if (folder === undefined || !existsSync(join(folder, "hobbots.sqlite"))) return yield* Effect.fail(usage);
  if (existsSync(defaultDataDir()) && realpathSync(folder) === realpathSync(defaultDataDir())) {
    return yield* Effect.fail(`${folder} is the hub's own data folder. Copy it and give the copy. Nothing changed.`);
  }
  const dataDir = yield* freeDataFolder(folder, "copy the folder while no hub runs");
  const database = join(dataDir, "hobbots.sqlite");
  const before = yield* onDatabaseFile(
    database,
    Effect.gen(function* () {
      if (!(yield* keepsThreadMarker)) {
        return yield* Effect.fail(`${database} has no thread read markers: it was migrated already. Nothing changed.`);
      }
      return yield* unreadByThreadMarker;
    }),
  );
  const after = yield* unreadByMember.pipe(Effect.provide(SqliteLive(database)));
  yield* report(before, after);
}).pipe(exitOnFailure);

NodeRuntime.runMain(dryRun);
