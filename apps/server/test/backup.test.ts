import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActivityStore,
  DeviceRepository,
  HobbotsRepository,
  type NewAttempt,
  SaveDestinations,
  TaskRepository,
  WorkHold,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  ArtifactId,
  AttemptId,
  ContentId,
  carriedFrom,
  DEFAULT_QUEST_LIMITS,
  Message,
  MessageId,
  PairingRequest,
  QuestId,
  TaskId,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import {
  copyLiveDatabase,
  DeviceRepositoryLive,
  EventJournal,
  HobbotsRepositoryLive,
  knownSchemaVersion,
  migrations,
  RestoreRepository,
  SqliteLive,
  TaskRepositoryLive,
} from "@hobbots/persistence";
import { Effect, Exit, Fiber, Latch, Layer, Option, Ref, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileStamp, listFiles, readBackup, restoreInto, restoreMarkerFile } from "../src/backup-files.ts";
import { BackupHolds, HeldActivityStore } from "../src/backup-holds.ts";
import { HubBackups, writeBackup } from "../src/backups.ts";
import { checkDestination } from "../src/destination.ts";
import { Installation } from "../src/installation.ts";
import { backupBeforeMigrations, migrationBackupsFolder } from "../src/migration-backup.ts";
import { performRestore, RestoreRulesLive, WorkHoldLive } from "../src/restores.ts";

// Backup and restore (ADR 026), on real SQLite files in real data folders: a backup made from a
// running hub's database, the data folder deleted, the backup restored, and the hub started again
// on it. These run on SQLite whatever database the rest of the suite uses, since a backup with its
// database included is a SQLite backup.

const now = "2026-11-03T10:00:00.000Z";
const FRODO = AgentId.make("frodo");
const threadId = ThreadId.make("shire");
const taskId = TaskId.make("ring");
/** Pasted into a message: a backup keeps chats exactly as written. */
const PASTED = "ghp_pastedIntoTheChatOnPurpose";
const SECRETS = {
  windowKey: "window-key-secret-0001",
  charm: "charm-private-key-0002",
  runtime: "runtime-sign-in-0003",
  env: "env-token-0004",
  deviceToken: "device-token-hash-0005",
  pairing: "pairing-secret-hash-0006",
};

let root: string;
let dataDir: string;
let destination: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hobbots-backup-"));
  dataDir = join(root, "data");
  destination = join(root, "backups");
  await mkdir(dataDir, { recursive: true });
  await mkdir(destination);
});

afterEach(async () => {
  delete process.env.HOBBOTS_BACKUP_TEST_TOKEN;
  await rm(root, { recursive: true, force: true });
});

const databaseOf = (dir: string) => join(dir, "hobbots.sqlite");

/** A hub's records on the SQLite file in `dir`, with the rules of a first start after a restore applied. */
const hubOn = (dir: string, record = migrations) =>
  Layer.mergeAll(
    HobbotsRepositoryLive,
    TaskRepositoryLive,
    DeviceRepositoryLive,
    RestoreRepository.layer,
    EventJournal.layer,
  ).pipe(Layer.provideMerge(RestoreRulesLive(dir)), Layer.provideMerge(SqliteLive(databaseOf(dir), record)));

type Hub = Layer.Success<ReturnType<typeof hubOn>>;
const onHub = <A, E>(dir: string, effect: Effect.Effect<A, E, Hub>, record = migrations) =>
  effect.pipe(Effect.provide(hubOn(dir, record)), Effect.runPromise);

const attempt: NewAttempt = {
  id: AttemptId.make("a1"),
  runtime: "claude-code",
  sessionId: null,
  configVersion: 1,
  policyVersion: "r3-0123456789abcdef",
  startedAt: now,
};

/** Frodo, a thread with a message, a Quest whose Task finished with an artifact, and two devices. */
const seed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(
    new Agent({
      id: FRODO,
      name: "Frodo",
      roleTitle: "Ring-bearer",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 1,
      lookColor: "moss",
      configVersion: 1,
      createdAt: now,
    }),
  );
  yield* repo.upsertThread(
    new Thread({ id: threadId, agentId: FRODO, title: "To Mordor", createdAt: now, updatedAt: now }),
  );
  yield* repo.upsertMessage(
    new Message({
      id: MessageId.make("m1"),
      threadId,
      role: "user",
      content: `Take the ring. ${PASTED}`,
      status: "complete",
      error: null,
      configVersion: null,
      createdAt: now,
    }),
  );
  const tasks = yield* TaskRepository;
  yield* tasks.createTask({
    task: { id: taskId, ownerId: FRODO, parentId: null, threadId, brief: "Destroy it", dependsOn: [], createdAt: now },
    delegation: null,
    milestones: [],
  });
  yield* tasks.startQuest({
    id: QuestId.make("q1"),
    taskId,
    goal: "Destroy the ring",
    acceptance: ["The ring is gone"],
    limits: DEFAULT_QUEST_LIMITS,
    createdAt: now,
  });
  const task = Option.getOrThrow(yield* tasks.readTree(taskId)).tasks[0];
  if (task === undefined) throw new Error("no Task");
  const started = yield* tasks.startAttempt(task.id, task.revision, attempt);
  yield* tasks.completeTask(task.id, started.value.task.revision, {
    summary: "Done at Mount Doom",
    attemptId: attempt.id,
    artifacts: [{ id: ArtifactId.make("report"), kind: "text", label: "Report", value: "The ring is gone." }],
    at: now,
    carried: carriedFrom(Option.getOrThrow(yield* tasks.readLedger(taskId)), () => true),
  });
  const devices = yield* DeviceRepository;
  yield* devices.ensureWindow(now);
  yield* devices.openPairing(
    new PairingRequest({
      id: "pr1",
      code: "482913",
      name: "Safari on iPhone",
      kind: "browser",
      platform: "iOS",
      tailscale: null,
      state: "pending",
      createdAt: now,
      expiresAt: "2026-11-03T10:10:00.000Z",
      decidedAt: null,
      deviceId: null,
    }),
    SECRETS.pairing,
  );
});

/** The files a hub keeps beside its database: what hobs made, the Workbench, tool logs, and the secrets. */
const seedFiles = async (dir: string) => {
  const write = async (path: string, text: string) => {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text);
  };
  await write("workspaces/default/notes/map.md", "There and back again.");
  await write("activity/a1/screenshot.txt", "A picture of the mountain.");
  await write("tool-logs/a1.log", "ran: walk");
  await write("network.json", JSON.stringify({ port: 4999, remoteAccess: true }));
  await write("installation-id", "original-installation\n");
  await write("window-key", SECRETS.windowKey);
  await write("charms/github/private-key.pem", SECRETS.charm);
  await write("desktop-settings.json", "{}");
  await mkdir(`${dir}-runtimes`, { recursive: true });
  await writeFile(join(`${dir}-runtimes`, "credentials.json"), SECRETS.runtime);
};

/** Copies the database from the hub's own open connection, as a running hub does. */
const liveCopy = Effect.map(
  Effect.context<Effect.Services<ReturnType<typeof copyLiveDatabase>>>(),
  (context) => (target: string) => copyLiveDatabase(target).pipe(Effect.provideContext(context)),
);

/** Backs up the hub at `dataDir` into `destination` with its database copied from the open connection. */
const backUp = (dir: string, folder: string) =>
  onHub(
    dir,
    Effect.flatMap(liveCopy, (copyDatabase) =>
      writeBackup({ dataDir: dir, folder, version: "0.15.0", installationId: "original-installation", copyDatabase }),
    ),
  );

const everyFileText = async (folder: string) => {
  const texts: Array<string> = [];
  for (const file of await listFiles(folder)) texts.push((await readFile(join(folder, file))).toString("latin1"));
  return texts.join("\n");
};

describe("backup and restore", () => {
  // covers OP-003
  it("[TC-OP-021] brings back threads, Quests and artifacts after the data folder is deleted", async () => {
    await onHub(dataDir, seed);
    await seedFiles(dataDir);
    const folder = join(destination, "one.hobbots-backup");
    const made = await backUp(dataDir, folder);
    expect(made.path).toBe(folder);

    await rm(dataDir, { recursive: true, force: true });
    const manifest = await readBackup(folder, knownSchemaVersion());
    expect(manifest).toMatchObject({
      format: "hobbots.backup",
      storage: "sqlite",
      database: "included",
      schemaVersion: knownSchemaVersion(),
      counts: { hobs: 1, threads: 1, quests: 1, tasks: 1 },
    });
    const setAside = await Effect.runPromise(performRestore(dataDir, folder));
    expect(setAside).toBeNull();
    expect((await readFile(join(dataDir, "installation-id"), "utf8")).trim()).not.toBe("original-installation");

    const restored = await onHub(
      dataDir,
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const tasks = yield* TaskRepository;
        const tree = Option.getOrThrow(yield* tasks.readTree(taskId));
        return {
          threads: yield* repo.listThreads(FRODO),
          messages: yield* repo.listMessages(threadId),
          quests: tree.quests,
          artifacts: tree.artifacts,
          restore: yield* (yield* RestoreRepository).latest,
          held: yield* (yield* WorkHold).held,
        };
      }).pipe(Effect.provide(WorkHoldLive)),
    );
    expect(restored.threads.map((thread) => thread.title)).toEqual(["To Mordor"]);
    expect(restored.messages.map((message) => message.content)).toEqual([`Take the ring. ${PASTED}`]);
    expect(restored.quests.map((quest) => quest.goal)).toEqual(["Destroy the ring"]);
    expect(restored.artifacts.map((artifact) => [artifact.label, artifact.value])).toEqual([
      ["Report", "The ring is gone."],
    ]);
    expect(Option.getOrThrow(restored.restore)).toMatchObject({
      setAside: null,
      resumedAt: null,
      backupVersion: "0.15.0",
    });
    expect(restored.held).toBe(true);
    expect(await readFile(join(dataDir, "workspaces/default/notes/map.md"), "utf8")).toBe("There and back again.");
    expect(await readFile(join(dataDir, "activity/a1/screenshot.txt"), "utf8")).toBe("A picture of the mountain.");
    expect(await readFile(join(dataDir, "tool-logs/a1.log"), "utf8")).toBe("ran: walk");
    expect(JSON.parse(await readFile(join(dataDir, "network.json"), "utf8"))).toEqual({ port: 4999 });
    await expect(lstat(restoreMarkerFile(dataDir))).rejects.toThrow();
  });

  // covers OP-003
  it("[TC-OP-022] leaves every key, token and sign-in out of the backup, and keeps what you pasted into a chat", async () => {
    process.env.HOBBOTS_BACKUP_TEST_TOKEN = SECRETS.env;
    await onHub(dataDir, seed);
    await seedFiles(dataDir);
    // A device that paired holds a token's hash in the hub's database.
    await onHub(
      dataDir,
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE devices SET token_hash = ${SECRETS.deviceToken}`),
    );
    const folder = join(destination, "two.hobbots-backup");
    await backUp(dataDir, folder);

    const files = await listFiles(folder);
    expect(files.filter((file) => /window-key|charms|runtimes|installation-id|desktop-settings/.test(file))).toEqual(
      [],
    );
    const text = await everyFileText(folder);
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    expect(text).toContain(PASTED);
    const network = JSON.parse(await readFile(join(folder, "settings", "network.json"), "utf8"));
    expect(network).toEqual({ port: 4999 });
    for (const file of files) expect((await lstat(join(folder, file))).mode & 0o077).toBe(0);
    expect((await lstat(folder)).mode & 0o077).toBe(0);
  });

  // covers OP-003
  it("[TC-OP-023] refuses a folder that is not a whole, unchanged backup, and changes nothing", async () => {
    await onHub(dataDir, seed);
    await seedFiles(dataDir);
    const folder = join(destination, "three.hobbots-backup");
    await backUp(dataDir, folder);
    const before = await listFiles(dataDir);
    const refused = async (path: string, reason: RegExp) => {
      const exit = await Effect.runPromiseExit(performRestore(dataDir, path));
      expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toMatch(reason);
      expect(await listFiles(dataDir)).toEqual(before);
    };
    await refused(join(destination, "nothing-here"), /no backup folder/);
    await mkdir(join(destination, "empty.hobbots-backup"));
    await refused(join(destination, "empty.hobbots-backup"), /manifest is missing/);

    const manifest = JSON.parse(await readFile(join(folder, "manifest.json"), "utf8"));
    await writeFile(join(folder, "manifest.json"), JSON.stringify({ ...manifest, schemaVersion: 99 }));
    await refused(folder, /newer Hobbots/);
    await writeFile(join(folder, "manifest.json"), JSON.stringify({ ...manifest, database: "external" }));
    await refused(folder, /holds no database/);
    await writeFile(
      join(folder, "manifest.json"),
      JSON.stringify({ ...manifest, files: [...manifest.files, { path: "../outside", size: 0, sha256: "" }] }),
    );
    await refused(folder, /outside it/);
    await writeFile(join(folder, "manifest.json"), JSON.stringify(manifest));
    await writeFile(join(folder, "workspace/notes/map.md"), "Changed after the backup.");
    await refused(folder, /does not match the backup's checksum/);
    await rm(join(folder, "workspace/notes/map.md"));
    await symlink(join(dataDir, "window-key"), join(folder, "workspace/notes/map.md"));
    await refused(folder, /holds a link/);
  });

  // covers OP-003
  it("[TC-OP-024] restores a backup from an older Hobbots and migrates it on the next start", async () => {
    const older = Object.fromEntries(Object.entries(migrations).filter(([id]) => id < "0038")) as typeof migrations;
    await Effect.runPromise(Effect.provide(Effect.void, SqliteLive(databaseOf(dataDir), older)));
    const folder = join(destination, "old.hobbots-backup");
    await Effect.runPromise(
      Effect.flatMap(liveCopy, (copyDatabase) =>
        writeBackup({ dataDir, folder, version: "0.14.0", installationId: "old", copyDatabase }),
      ).pipe(Effect.provide(SqliteLive(databaseOf(dataDir), older))),
    );
    expect((await readBackup(folder, 38)).schemaVersion).toBe(37);
    const target = join(root, "fresh");
    await Effect.runPromise(performRestore(target, folder));
    const restore = await onHub(
      target,
      Effect.flatMap(RestoreRepository, (repo) => repo.latest),
    );
    expect(Option.getOrThrow(restore)).toMatchObject({ backupVersion: "0.14.0", resumedAt: null });
  });

  // covers OP-003
  it("[TC-OP-025] sets the hub's data aside beside the folder and leaves the desktop app's own files", async () => {
    await onHub(dataDir, seed);
    await seedFiles(dataDir);
    const folder = join(destination, "four.hobbots-backup");
    await backUp(dataDir, folder);
    await writeFile(join(dataDir, "workspaces/default/notes/later.md"), "Written after the backup.");

    const setAside = await Effect.runPromise(performRestore(dataDir, folder));
    expect(setAside).toMatch(/\/data\.before-restore-\d{4}-\d{2}-\d{2}-\d{2}\.\d{2}\.\d{2}$/);
    const aside = setAside as string;
    expect(await readFile(join(aside, "workspaces/default/notes/later.md"), "utf8")).toBe("Written after the backup.");
    expect(await readFile(join(aside, "window-key"), "utf8")).toBe(SECRETS.windowKey);
    expect(await readFile(join(dataDir, "desktop-settings.json"), "utf8")).toBe("{}");
    await expect(lstat(join(dataDir, "window-key"))).rejects.toThrow();
    await expect(lstat(join(dataDir, "workspaces/default/notes/later.md"))).rejects.toThrow();
    const restore = await onHub(
      dataDir,
      Effect.flatMap(RestoreRepository, (repo) => repo.latest),
    );
    expect(Option.getOrThrow(restore).setAside).toBe(aside);
    expect((await readdir(root)).sort()).toEqual(["backups", "data", "data-runtimes", aside.split("/").at(-1)].sort());
  });

  // covers OP-003
  it("[TC-OP-026] saves a backup only outside the data folder and every folder hobs work in", async () => {
    // Hob folders and the answer are canonical, which differs where the temp folder is a symlink.
    const hobFolder = join(await realpath(root), "code");
    await mkdir(join(hobFolder, "site"), { recursive: true });
    const inside = await Effect.runPromiseExit(checkDestination(join(hobFolder, "site"), [hobFolder], root));
    expect(Exit.isFailure(inside) && JSON.stringify(inside.cause)).toMatch(/a folder hobs work in/);
    expect(await Effect.runPromise(checkDestination(destination, [hobFolder], root))).toBe(await realpath(destination));

    const backups = HubBackups.layer.pipe(
      Layer.provide(Layer.succeed(Installation, { app: "hobbots", installationId: "i", version: "0.15.0", dataDir })),
      Layer.provide(BackupHolds.layer),
      Layer.provide(Layer.succeed(SaveDestinations, { check: (typed: string) => Effect.succeed(typed) })),
      Layer.provide(SqliteLive(databaseOf(dataDir))),
    );
    const result = await Effect.gen(function* () {
      const hub = yield* HubBackups;
      const intoData = yield* hub.start(join(dataDir, "workspaces")).pipe(Effect.flip);
      const started = yield* hub.start(destination);
      const twice = yield* hub.start(destination).pipe(Effect.flip);
      const cancelled = yield* hub.cancel;
      return { intoData, started, twice, cancelled };
    }).pipe(Effect.provide(backups), Effect.runPromise);
    expect(result.intoData).toMatchObject({
      _tag: "BackupRefused",
      reason: expect.stringMatching(/outside the Hobbots data folder/),
    });
    expect(result.started.state._tag).toBe("Copying");
    expect(result.twice).toMatchObject({ _tag: "BackupRefused", reason: "A backup is already running." });
    expect(result.cancelled.state).toMatchObject({ _tag: "Failed", reason: "You cancelled the backup." });
    expect((await readdir(destination)).filter((name) => name.endsWith(".hobbots-backup"))).toEqual([]);
  });

  // covers OP-003
  it("[TC-OP-027] waits for replies in the default workspace and starts none until it is copied", async () => {
    const result = await Effect.gen(function* () {
      const holds = yield* BackupHolds;
      const log = yield* Ref.make<ReadonlyArray<string>>([]);
      const note = (line: string) => Ref.update(log, (lines) => [...lines, line]);
      const finishFirst = yield* Latch.make(false);
      // A reply already running in the default workspace.
      const running = yield* holds
        .workspaceTurn(Stream.fromEffect(Effect.andThen(finishFirst.await, note("first reply ended"))))
        .pipe(Stream.runDrain, Effect.forkChild);
      yield* Effect.yieldNow;
      const backup = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* holds.holdWorkspace((turns) => note(`waiting for ${turns}`));
          yield* note("copied the workspace");
        }),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      // A reply asked for while the hold stands waits for it.
      const later = yield* holds
        .workspaceTurn(Stream.fromEffect(note("second reply started")))
        .pipe(Stream.runDrain, Effect.forkChild);
      yield* Effect.sleep("20 millis");
      yield* finishFirst.open;
      yield* Fiber.join(running);
      yield* Fiber.join(backup);
      yield* Fiber.join(later);
      return yield* Ref.get(log);
    }).pipe(Effect.provide(BackupHolds.layer), Effect.runPromise);
    expect(result).toEqual([
      "waiting for 1",
      "first reply ended",
      "waiting for 0",
      "copied the workspace",
      "second reply started",
    ]);
  });

  // covers OP-003
  it("[TC-OP-028] deletes no Workbench content while a backup holds cleanup, and waits for a deletion under way", async () => {
    const result = await Effect.gen(function* () {
      const removed = yield* Ref.make<ReadonlyArray<string>>([]);
      const log = yield* Ref.make<ReadonlyArray<string>>([]);
      const note = (line: string) => Ref.update(log, (lines) => [...lines, line]);
      const finishDeleting = yield* Latch.make(false);
      // The hub's store, whose first deletion takes a while, as a slow disk would.
      const Store = Layer.succeed(
        ActivityStore,
        ActivityStore.of({
          put: () => Effect.die("unused"),
          has: () => Effect.succeed(true),
          get: () => Effect.succeed(Option.none()),
          list: Effect.succeed([]),
          remove: (ids) =>
            Effect.gen(function* () {
              if (ids.includes(ContentId.make(`${"a".repeat(64)}`))) yield* finishDeleting.await;
              yield* Ref.update(removed, (all) => [...all, ...ids]);
              yield* note(`deleted ${ids.length}`);
            }),
        }),
      );
      return yield* Effect.gen(function* () {
        const holds = yield* BackupHolds;
        const store = yield* ActivityStore;
        const slow = yield* store.remove([ContentId.make("a".repeat(64))]).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const backup = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* holds.holdCleanup;
            yield* note("cleanup held");
            // A turn that replaced a content, and the hourly cleanup, delete nothing now.
            yield* store.remove([ContentId.make("b".repeat(64))]);
            yield* note("copied the Workbench");
          }),
        ).pipe(Effect.forkChild);
        yield* Effect.sleep("20 millis");
        yield* finishDeleting.open;
        yield* Fiber.join(slow);
        yield* Fiber.join(backup);
        yield* store.remove([ContentId.make("c".repeat(64))]);
        return { log: yield* Ref.get(log), removed: yield* Ref.get(removed), held: yield* holds.cleanupHeld };
      }).pipe(Effect.provide(HeldActivityStore.pipe(Layer.provide(Store), Layer.provideMerge(BackupHolds.layer))));
    }).pipe(Effect.runPromise);
    expect(result.log).toEqual(["deleted 1", "cleanup held", "copied the Workbench", "deleted 1"]);
    expect(result.removed).toEqual(["a".repeat(64), "c".repeat(64)]);
    expect(result.held).toBe(false);
  });

  // covers OP-003
  it("[TC-OP-029] holds work after a restore until you resume it, across a restart", async () => {
    await onHub(dataDir, seed);
    const folder = join(destination, "five.hobbots-backup");
    await backUp(dataDir, folder);
    await Effect.runPromise(performRestore(dataDir, folder));
    const held = WorkHold.use((hold) => hold.held).pipe(Effect.provide(WorkHoldLive));
    expect(await onHub(dataDir, held)).toBe(true);
    expect(await onHub(dataDir, held)).toBe(true);
    await onHub(
      dataDir,
      Effect.flatMap(RestoreRepository, (repo) => repo.resume(now)),
    );
    expect(await onHub(dataDir, held)).toBe(false);
    // A hub that was never restored holds nothing.
    await mkdir(join(root, "new"));
    expect(await onHub(join(root, "new"), held)).toBe(false);
  });

  // covers OP-003
  it("[TC-OP-031] backs up the data folder before an update migrates it, keeping only the latest", async () => {
    const older = Object.fromEntries(Object.entries(migrations).filter(([id]) => id < "0038")) as typeof migrations;
    expect(await Effect.runPromise(backupBeforeMigrations(dataDir, "0.15.0"))).toBeNull();
    await Effect.runPromise(Effect.provide(Effect.void, SqliteLive(databaseOf(dataDir), older)));
    await writeFile(join(dataDir, "window-key"), SECRETS.windowKey);
    const first = await Effect.runPromise(backupBeforeMigrations(dataDir, "0.15.0"));
    const second = await Effect.runPromise(backupBeforeMigrations(dataDir, "0.15.0"));
    expect(first).not.toBeNull();
    const kept = await readdir(migrationBackupsFolder(dataDir));
    expect(kept).toEqual([second?.split("/").at(-1)]);
    expect((await readBackup(second as string, 38)).schemaVersion).toBe(37);
    expect(await everyFileText(second as string)).not.toContain(SECRETS.windowKey);
    // Once migrated, the next start makes none.
    await Effect.runPromise(Effect.provide(Effect.void, SqliteLive(databaseOf(dataDir))));
    expect(await Effect.runPromise(backupBeforeMigrations(dataDir, "0.15.0"))).toBeNull();
  });

  // covers OP-003
  it("[TC-OP-033] keeps the hub's own data when a restore fails while setting it aside or copying in", async () => {
    await onHub(dataDir, seed);
    await seedFiles(dataDir);
    const folder = join(destination, "six.hobbots-backup");
    await backUp(dataDir, folder);
    const manifest = await readBackup(folder, knownSchemaVersion());
    const snapshot = async () => {
      const files = await listFiles(dataDir);
      return Object.fromEntries(
        await Promise.all(files.map(async (file) => [file, (await readFile(join(dataDir, file))).toString("base64")])),
      );
    };
    const before = await snapshot();

    // The folder beside it is already there, so nothing can be set aside: nothing changes.
    const at = new Date("2026-11-03T12:00:00.000Z");
    const aside = `${dataDir}.before-restore-${fileStamp(at).replace(" ", "-")}`;
    await mkdir(aside);
    await writeFile(join(aside, "someone-elses.txt"), "keep me");
    await expect(restoreInto(dataDir, folder, manifest, at)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(await readdir(aside)).toEqual(["someone-elses.txt"]);

    // A file of the backup goes missing after it was checked: what was copied in is removed and the
    // hub's own data is moved back.
    await rm(join(folder, "tool-logs", "a1.log"));
    const later = new Date("2026-11-03T12:00:05.000Z");
    await expect(restoreInto(dataDir, folder, manifest, later)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await expect(lstat(`${dataDir}.before-restore-${fileStamp(later).replace(" ", "-")}`)).rejects.toThrow();
  });

  // covers OP-003
  it("[TC-OP-037] backs up an older data folder before migrating it, from any earlier schema", async () => {
    for (const before of ["0005", "0030"]) {
      const dir = join(root, `schema-${before}`);
      await mkdir(dir);
      const older = Object.fromEntries(Object.entries(migrations).filter(([id]) => id < before)) as typeof migrations;
      await Effect.runPromise(Effect.provide(Effect.void, SqliteLive(databaseOf(dir), older)));
      const made = await Effect.runPromise(backupBeforeMigrations(dir, "0.15.0"));
      expect(made).not.toBeNull();
      const manifest = await readBackup(made as string, 38);
      expect(manifest.schemaVersion).toBe(Number(before) - 1);
      expect(manifest.counts).toEqual({ hobs: 0, threads: 0, quests: 0, tasks: 0 });
      // The next start migrates it.
      await Effect.runPromise(Effect.provide(Effect.void, SqliteLive(databaseOf(dir))));
    }
  });
});
