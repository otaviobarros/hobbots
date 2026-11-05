import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HobbotsRepository, RetiredHobGitHubApp } from "@hobbots/agents";
import { GitHubConnection } from "@hobbots/charms";
import { Agent, AgentId } from "@hobbots/domain";
import { HobbotsRepositoryLive, SqliteLive } from "@hobbots/persistence";
import { Effect, Exit, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finishReset, HubReset, resetMarkerFile, wipeHubData } from "../src/resets.ts";
import { HubRestart } from "../src/restores.ts";

// Start over (#948), on real data folders: what it deletes, what it keeps, and how a reset that
// stopped halfway is finished on the next start.

let root: string;
let dataDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hobbots-reset-"));
  dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const write = async (path: string, text: string) => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
};

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** A hub's files, the runtimes folder beside it, a folder a restore set aside, and the desktop app's own files. */
const seedHub = async () => {
  await write(join(dataDir, "hobbots.sqlite"), "database");
  await write(join(dataDir, "hobbots.sqlite-wal"), "wal");
  await write(join(dataDir, "workspaces/default/notes.md"), "There and back again.");
  await write(join(dataDir, "activity/a1/screenshot.txt"), "A picture.");
  await write(join(dataDir, "tool-logs/a1.log"), "ran: walk");
  await write(join(dataDir, "network.json"), "{}");
  await write(join(dataDir, "installation-id"), "original\n");
  await write(join(dataDir, "window-key"), "window-key-secret");
  await write(join(dataDir, "charms/github/sandbox/state"), "state");
  await write(join(dataDir, "backups/latest.hobbots-backup/manifest.json"), "{}");
  await write(join(dataDir, "desktop-settings.json"), '{"openAtLogin":true}');
  await write(join(dataDir, "Local Storage/leveldb/000001.log"), "window");
  await write(join(`${dataDir}-runtimes`, "frodo/credentials.json"), "runtime-sign-in");
  await write(join(`${dataDir}.before-restore-2026-11-03-14.05.09`, "hobbots.sqlite"), "older data");
  await write(join(root, "data-notes/keep.md"), "Not the hub's.");
};

describe("start over", () => {
  // covers #948
  it("[TC-OP-094] deletes everything the hub keeps and leaves the desktop app's own files", async () => {
    await seedHub();
    await wipeHubData(dataDir);
    expect((await readdir(dataDir)).sort()).toEqual(["Local Storage", "desktop-settings.json"]);
    expect(await readFile(join(dataDir, "desktop-settings.json"), "utf8")).toBe('{"openAtLogin":true}');
    expect((await readdir(root)).sort()).toEqual(["data", "data-notes"]);
  });

  // covers #948
  it("[TC-OP-095] finishes a reset that stopped halfway on the next start, and leaves a data folder without one", async () => {
    await seedHub();
    expect(await finishReset(dataDir)).toBe(false);
    expect(await exists(join(dataDir, "hobbots.sqlite"))).toBe(true);

    // The marker is there and only part of the hub's data was deleted when the process stopped.
    await writeFile(resetMarkerFile(dataDir), "{}\n");
    await rm(join(dataDir, "hobbots.sqlite"));
    expect(await finishReset(dataDir)).toBe(true);
    expect((await readdir(dataDir)).sort()).toEqual(["Local Storage", "desktop-settings.json"]);
    expect(await exists(`${dataDir}-runtimes`)).toBe(false);
  });

  // covers #948
  it("[TC-OP-096] forgets the GitHub sign-in and every hob's own app, then asks the hub to restart empty", async () => {
    const calls: Array<string> = [];
    const hobs = ["frodo", "sam"].map(
      (id, index) =>
        new Agent({
          id: AgentId.make(id),
          name: id,
          roleTitle: "Hobbit",
          runtime: "claude-code",
          model: null,
          effort: null,
          instructions: "",
          lookSeed: index,
          lookColor: "moss",
          configVersion: 1,
          createdAt: "2026-11-05T10:00:00.000Z",
          ...(id === "sam" ? { status: "retired" as const, retiredAt: "2026-11-05T11:00:00.000Z" } : {}),
        }),
    );
    const services = Layer.mergeAll(
      Layer.succeed(HubRestart, {
        restore: () => Effect.void,
        reset: Effect.sync(() => void calls.push("restart")),
      }),
      Layer.succeed(RetiredHobGitHubApp, { remove: (id) => Effect.sync(() => void calls.push(`app ${id}`)) }),
      Layer.succeed(GitHubConnection, {
        disconnect: Effect.sync(() => {
          calls.push("github");
          return { _tag: "Disconnected" };
        }),
      } as unknown as GitHubConnection["Service"]),
    );
    const program = Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      for (const hob of hobs) yield* repo.insertAgent(hob);
      yield* (yield* HubReset).start;
      yield* Effect.sleep("400 millis");
    });
    await program.pipe(
      Effect.provide(
        HubReset.layer.pipe(
          Layer.provideMerge(HobbotsRepositoryLive),
          Layer.provide(SqliteLive(join(dataDir, "hobbots.sqlite"))),
          Layer.provide(services),
        ),
      ),
      Effect.runPromise,
    );
    expect(calls).toEqual(["app frodo", "app sam", "github", "restart"]);
  });

  // covers #948
  it("[TC-OP-097] refuses to start over on a hub that cannot restart itself, and changes nothing", async () => {
    const exit = await Effect.flatMap(HubReset, (reset) => reset.start).pipe(
      Effect.provide(
        HubReset.layer.pipe(
          Layer.provide(HobbotsRepositoryLive),
          Layer.provide(SqliteLive(join(dataDir, "hobbots.sqlite"))),
        ),
      ),
      Effect.runPromiseExit,
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("ResetRefused");
  });
});
