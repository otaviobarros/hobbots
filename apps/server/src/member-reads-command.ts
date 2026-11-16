import { existsSync } from "node:fs";
import { join } from "node:path";
import { NodeRuntime } from "@effect/platform-node";
import {
  type ChannelUnread,
  keepsChannelMarker,
  onDatabaseFile,
  SqliteLive,
  unreadByChannelMarker,
  unreadByMember,
} from "@hobbots/persistence";
import { Console, Effect } from "effect";
import { exitOnFailure, freeDataFolder, isHubDataFolder } from "./command-line.ts";
import { defaultDataDir, ServerConfig } from "./config.ts";

// A dry run of migration 20261114004500 (ADR 039, read markers per member; #1454) on a copy of a hub's data
// folder: `pnpm --filter @hobbots/server member-reads <copy>` prints each channel's unread replies by
// the channel's own read marker, migrates the copy to this checkout's schema, and prints them again by
// the owner's member row. It exits with status 1 when any channel reads differently. It changes the
// copy's database, so it refuses the hub's own folder and one a hub is using.

const usage = "Give the folder of a copy of a hub's data folder: pnpm --filter @hobbots/server member-reads <copy>.";

const row = (cells: ReadonlyArray<string>, widths: ReadonlyArray<number>) =>
  cells.map((cell, index) => cell.slice(0, widths[index]).padEnd(widths[index] ?? 0)).join("  ");

const report = (before: ReadonlyArray<ChannelUnread>, after: ReadonlyArray<ChannelUnread>) =>
  Effect.gen(function* () {
    const afterOf = new Map(after.map((channel) => [channel.channelId, channel.unread]));
    const widths = [28, 36, 16, 6, 6];
    yield* Console.log(row(["Channel", "Title", "Hob", "Before", "After"], widths));
    let differ = 0;
    for (const channel of before) {
      const moved = afterOf.get(channel.channelId);
      if (moved !== channel.unread) differ += 1;
      const mark = moved === channel.unread ? "" : "  differs";
      yield* Console.log(
        `${row([channel.channelId, channel.title, channel.agentId, String(channel.unread), String(moved ?? "gone")], widths)}${mark}`,
      );
    }
    const sum = (channels: ReadonlyArray<ChannelUnread>) => channels.reduce((total, each) => total + each.unread, 0);
    const unreadChannels = (channels: ReadonlyArray<ChannelUnread>) =>
      channels.filter((each) => each.unread > 0).length;
    yield* Console.log(
      `${before.length} channels. Before: ${sum(before)} unread replies in ${unreadChannels(before)} channels. ` +
        `After: ${sum(after)} unread replies in ${unreadChannels(after)} channels.`,
    );
    if (differ > 0 || after.length !== before.length) {
      return yield* Effect.fail(`${differ} channels read differently after the migration.`);
    }
    yield* Console.log("Every channel reads the same before and after.");
  });

const dryRun = Effect.gen(function* () {
  const folder = process.argv[2];
  if (folder === undefined || !existsSync(join(folder, "hobbots.sqlite"))) return yield* Effect.fail(usage);
  // The hub's own folder, wherever it is set (HOBBOTS_DATA_DIR) and where it is by default.
  const config = yield* ServerConfig;
  if (isHubDataFolder(folder, [config.dataDir, defaultDataDir()])) {
    return yield* Effect.fail(`${folder} is the hub's own data folder. Copy it and give the copy. Nothing changed.`);
  }
  const dataDir = yield* freeDataFolder(folder, "copy the folder while no hub runs");
  const database = join(dataDir, "hobbots.sqlite");
  const before = yield* onDatabaseFile(
    database,
    Effect.gen(function* () {
      if (!(yield* keepsChannelMarker)) {
        return yield* Effect.fail(`${database} has no channel read markers: it was migrated already. Nothing changed.`);
      }
      return yield* unreadByChannelMarker;
    }),
  );
  const after = yield* unreadByMember.pipe(Effect.provide(SqliteLive(database)));
  yield* report(before, after);
}).pipe(exitOnFailure);

NodeRuntime.runMain(dryRun);
