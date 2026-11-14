import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActivityStore,
  DeviceRepository,
  HobbotsRepository,
  type NewAttempt,
  SaveDestinations,
  SkillLibrary,
  TaskRepository,
  WebRecords,
  WorkHold,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  ArtifactId,
  AttemptId,
  ContentId,
  CriterionId,
  carriedFrom,
  DEFAULT_MEMORY_SETTINGS,
  DEFAULT_QUEST_LIMITS,
  Message,
  MessageId,
  OWNER_ACTOR,
  PairingRequest,
  QuestId,
  SkillName,
  SkillRevisionHash,
  TaskId,
  Thread,
  ThreadId,
  WebFetchRecord,
  WebRecordId,
  WebSearchRecord,
} from "@hobbots/domain";
import {
  checkMemoryArchive,
  loadOrCreateMemoryKeys,
  memoryFolder,
  memoryKeysFile,
  packStoppedMemory,
} from "@hobbots/memory";
import {
  copyLiveDatabase,
  DeviceRepositoryLive,
  EventJournal,
  HobbotsRepositoryLive,
  knownMigrationIds,
  knownSchemaVersion,
  migrations,
  RestoreRepository,
  SkillLibraryLive,
  SqliteLive,
  TaskRepositoryLive,
  WebRecordsLive,
} from "@hobbots/persistence";
import { AgentsFolder, SkillImporter, SkillObjects } from "@hobbots/skills";
import { Effect, Exit, Fiber, Latch, Layer, Option, Redacted, Ref, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  copySkillObjects,
  fileStamp,
  listFiles,
  MEMORY_PART,
  readBackup,
  removeTree,
  restoreInto,
  restoreMarkerFile,
} from "../src/backup-files.ts";
import { BackupHolds, HeldActivityStore } from "../src/backup-holds.ts";
import { HubBackups, writeBackup } from "../src/backups.ts";
import { checkDestination } from "../src/destination.ts";
import { Installation } from "../src/installation.ts";
import { readMemorySettings } from "../src/memory-settings.ts";
import { backupBeforeMigrations, migrationBackupsFolder } from "../src/migration-backup.ts";
import { wipeHubData } from "../src/resets.ts";
import { performRestore, RestoreRulesLive, skillsNotHere, WorkHoldLive } from "../src/restores.ts";
import { SkillsLive } from "../src/skills.ts";

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
  // A skill revision's folders are read-only, so they are opened before they are deleted.
  await removeTree(root);
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
    WebRecordsLive,
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
      actor: OWNER_ACTOR,
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
    // Optional, so the Quest completes without checks; quest-criteria.test.ts holds the gate.
    criteria: [{ id: CriterionId.make("c-ring"), text: "The ring is gone", required: false }],
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

/** Memory as its engine leaves it in the data folder: a page in the wiki, its database and config. */
const MEMORY_PAGE = "wiki/hobbots/hob-frodo/notes/route.md";
const seedMemory = async (dir: string) => {
  await mkdir(join(memoryFolder(dir), "wiki/hobbots/hob-frodo/notes"), { recursive: true });
  await mkdir(join(memoryFolder(dir), "db"), { recursive: true });
  await writeFile(join(memoryFolder(dir), MEMORY_PAGE), "# Route\n\nThrough Moria.");
  await writeFile(join(memoryFolder(dir), "db", "memory.sqlite"), "an index");
  await writeFile(join(memoryFolder(dir), "config.toml"), 'log_level = "info"\n');
};

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

  // covers OP-003, ADR 036 (Usage and limits: backups)
  it("[TC-OP-1269-01] brings back web searches, pages read, Settings › Web and a hob's own limits", async () => {
    const where = {
      agentId: FRODO,
      threadId,
      messageId: MessageId.make("m1"),
      taskId: null,
      attemptId: null,
      turn: "reply:m1",
      at: now,
    };
    const search = new WebSearchRecord({
      ...where,
      id: WebRecordId.make("w1"),
      runtime: "claude-code",
      query: "the way to Mordor",
      resultCount: 1,
      results: [{ title: "Maps", url: "https://maps.test/" }],
      billing: "subscription (Max)",
    });
    const page = new WebFetchRecord({
      ...where,
      id: WebRecordId.make("w2"),
      url: "https://maps.test/",
      finalUrl: "https://maps.test/",
      status: 200,
      bytes: 512,
      parts: 1,
      part: 1,
      tokens: 128,
    });
    const settings = {
      limits: { searchesPerTurn: 4, pagesPerTurn: 8, searchesPerDay: 16 },
      blockedSites: ["isengard.test"],
    };
    const limits = { searchesPerTurn: 2, pagesPerTurn: null, searchesPerDay: null };
    await onHub(
      dataDir,
      Effect.gen(function* () {
        yield* seed;
        const records = yield* WebRecords;
        yield* records.recordSearch(search);
        yield* records.recordFetch(page);
        yield* records.setSettings(settings);
        yield* records.setHobLimits(FRODO, limits);
      }),
    );
    const folder = join(destination, "web.hobbots-backup");
    await backUp(dataDir, folder);
    await rm(dataDir, { recursive: true, force: true });
    await Effect.runPromise(performRestore(dataDir, folder));
    const restored = await onHub(
      dataDir,
      Effect.gen(function* () {
        const records = yield* WebRecords;
        return {
          usage: yield* records.usage({ agentId: FRODO }, 10),
          settings: yield* records.settings,
          limits: yield* records.hobLimits(FRODO),
        };
      }),
    );
    expect(restored.usage.searches).toEqual([search]);
    expect(restored.usage.pages).toEqual([page]);
    expect(restored.settings).toEqual(settings);
    expect(restored.limits).toEqual(limits);
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
    await writeFile(
      join(folder, "manifest.json"),
      JSON.stringify({ ...manifest, schemaVersion: knownSchemaVersion() + 1 }),
    );
    await refused(folder, /newer Hobbots/);
    // A newer Hobbots can add a migration below this one's highest (ADR 040): same schema version,
    // one id this Hobbots never applied.
    expect(manifest.migrations).toEqual([...knownMigrationIds()].sort((a, b) => a - b));
    let unknownId = knownSchemaVersion() - 1;
    while (knownMigrationIds().has(unknownId)) unknownId--;
    await writeFile(
      join(folder, "manifest.json"),
      JSON.stringify({
        ...manifest,
        schemaVersion: knownSchemaVersion(),
        migrations: [...manifest.migrations, unknownId].sort((a: number, b: number) => a - b),
      }),
    );
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
    expect((await readBackup(folder, 41)).schemaVersion).toBe(37);
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
    await seedMemory(dataDir);
    const first = await Effect.runPromise(backupBeforeMigrations(dataDir, "0.15.0"));
    const second = await Effect.runPromise(backupBeforeMigrations(dataDir, "0.15.0"));
    expect(first).not.toBeNull();
    const kept = await readdir(migrationBackupsFolder(dataDir));
    expect(kept).toEqual([second?.split("/").at(-1)]);
    expect((await readBackup(second as string, 38)).schemaVersion).toBe(37);
    // Memory's engine is not running before the hub starts, so its files are packed as they are.
    expect((await readBackup(second as string, 38)).files.map((file) => file.path)).toContain(MEMORY_PART);
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
      const manifest = await readBackup(made as string, 41);
      expect(manifest.schemaVersion).toBe(Number(before) - 1);
      expect(manifest.counts).toEqual({ hobs: 0, threads: 0, quests: 0, tasks: 0, skills: 0 });
      // The next start migrates it.
      await Effect.runPromise(Effect.provide(Effect.void, SqliteLive(databaseOf(dir))));
    }
  });

  // covers OP-003, ADR 028 (Backups)
  it("[TC-OP-099] keeps memory in the backup with no bearer, restores it with new bearers, and stops when memory cannot be saved", async () => {
    await onHub(dataDir, seed);
    await seedFiles(dataDir);
    await seedMemory(dataDir);
    const chosen = { ...DEFAULT_MEMORY_SETTINGS, fallback: "other" as const };
    await writeFile(join(dataDir, "memory-settings.json"), JSON.stringify(chosen));
    const old = loadOrCreateMemoryKeys(dataDir);
    const folder = join(destination, "memory.hobbots-backup");
    await onHub(
      dataDir,
      Effect.flatMap(liveCopy, (copyDatabase) =>
        writeBackup({
          dataDir,
          folder,
          version: "0.15.0",
          installationId: "original-installation",
          copyDatabase,
          backupMemory: (target) => packStoppedMemory(memoryFolder(dataDir), target, old),
        }),
      ),
    );
    const manifest = await readBackup(folder, knownSchemaVersion());
    expect(manifest.files.map((file) => file.path)).toContain(MEMORY_PART);
    // The memory model you chose goes beside the port.
    expect(manifest.files.map((file) => file.path)).toContain("settings/memory-settings.json");
    // Neither bearer is in the backup, in the archive or anywhere else.
    await Effect.runPromise(checkMemoryArchive(join(folder, MEMORY_PART), old));
    const text = await everyFileText(folder);
    expect(text).not.toContain(Redacted.value(old.root));
    expect(text).not.toContain(Redacted.value(old.proxy));
    expect((await listFiles(folder)).filter((file) => file.includes("memory-keys"))).toEqual([]);

    const setAside = (await Effect.runPromise(performRestore(dataDir, folder))) as string;
    expect(await readFile(join(memoryFolder(dataDir), MEMORY_PAGE), "utf8")).toBe("# Route\n\nThrough Moria.");
    expect(readMemorySettings(dataDir)).toEqual(chosen);
    const fresh = loadOrCreateMemoryKeys(dataDir);
    expect(Redacted.value(fresh.root)).not.toBe(Redacted.value(old.root));
    expect(Redacted.value(fresh.proxy)).not.toBe(Redacted.value(old.proxy));
    expect((await lstat(memoryKeysFile(dataDir))).mode & 0o777).toBe(0o600);
    // The old keys and memory went aside with the rest of the hub's data.
    expect(await readFile(join(setAside, "memory-keys"), "utf8")).toContain(Redacted.value(old.root));
    expect(await readFile(join(setAside, "memory", MEMORY_PAGE), "utf8")).toBe("# Route\n\nThrough Moria.");

    // A backup whose memory cannot be saved stops, says why and leaves nothing behind.
    const failing = join(destination, "no-memory.hobbots-backup");
    const exit = await onHub(
      dataDir,
      Effect.flatMap(liveCopy, (copyDatabase) =>
        writeBackup({
          dataDir,
          folder: failing,
          version: "0.15.0",
          installationId: "i",
          copyDatabase,
          backupMemory: () => Effect.fail({ reason: "memory is not answering right now" }),
        }),
      ).pipe(Effect.exit),
    );
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toMatch(
      /Hobbots could not back up memory: memory is not answering right now\./,
    );
    await expect(lstat(failing)).rejects.toThrow();
  });
  // covers OP-003, ADR 029 (Backups, exports and Diagnostics), #1064
  it("[TC-OP-115] brings back every skill revision, assignment, hold and pin, with each revision's files read-only", async () => {
    await onHub(dataDir, seed);
    const source = join(root, "release");
    await mkdir(join(source, "scripts"), { recursive: true });
    const skillFile = (text: string) =>
      writeFile(
        join(source, "SKILL.md"),
        `---\nname: release\ndescription: How this repository releases.\n---\n${text}\n`,
      );
    await skillFile("Tag, then push.");
    await writeFile(join(source, "scripts", "tag.sh"), "git tag v1\n");
    await chmod(join(source, "scripts", "tag.sh"), 0o755);
    const skills = SkillsLive(dataDir, null).pipe(Layer.provideMerge(SkillLibraryLive));
    const before = await onHub(
      dataDir,
      Effect.gen(function* () {
        const importer = yield* SkillImporter;
        const library = yield* SkillLibrary;
        const [first] = yield* importer.add({ _tag: "Folder", path: source }, { by: { _tag: "You" } });
        if (first === undefined) throw new Error("nothing imported");
        yield* Effect.promise(() => skillFile("Tag, push, then write the notes."));
        const [second] = yield* importer.add(
          { _tag: "Folder", path: source },
          { by: { _tag: "You" }, skillId: first.skill.id },
        );
        if (second === undefined) throw new Error("no second revision");
        const by = { _tag: "You" } as const;
        const base = { skillId: first.skill.id, onlyWhenAsked: false, by };
        yield* library.assign({ ...base, scope: { _tag: "Everyone" }, pin: second.revision.hash, held: false });
        yield* library.assign({
          ...base,
          scope: { _tag: "Hob", agentId: FRODO },
          pin: first.revision.hash,
          held: true,
        });
        return { skillId: first.skill.id, r1: first.revision.hash, r2: second.revision.hash };
      }).pipe(Effect.provide(skills)),
    );
    const folder = join(destination, "skills.hobbots-backup");
    await backUp(dataDir, folder);
    const manifest = await readBackup(folder, knownSchemaVersion());
    expect(manifest.counts.skills).toBe(1);
    const paths = manifest.files.map((file) => file.path);
    for (const hash of [before.r1, before.r2]) {
      expect(paths).toContain(`skills/${hash}/SKILL.md`);
      expect(paths).toContain(`skills/${hash}/scripts/tag.sh`);
    }

    await removeTree(dataDir);
    await Effect.runPromise(performRestore(dataDir, folder));
    const after = await onHub(
      dataDir,
      Effect.gen(function* () {
        const library = yield* SkillLibrary;
        const objects = yield* SkillObjects;
        return {
          skills: yield* library.list,
          revisions: yield* library.revisions(before.skillId),
          assignments: yield* library.assignments(before.skillId),
          folders: [yield* objects.folder(before.r1), yield* objects.folder(before.r2)],
        };
      }).pipe(Effect.provide(skills)),
    );
    expect(after.skills.map((skill) => [skill.name, skill.latest])).toEqual([["release", before.r2]]);
    expect(after.revisions.map((revision) => [revision.number, revision.hash])).toEqual([
      [2, before.r2],
      [1, before.r1],
    ]);
    expect(after.assignments.map((one) => [one.scope._tag, one.pin, one.held]).sort()).toEqual([
      ["Everyone", before.r2, false],
      ["Hob", before.r1, true],
    ]);
    for (const revision of after.folders) {
      if (revision === null) throw new Error("a revision's files did not come back");
      expect(await readFile(join(revision, "scripts", "tag.sh"), "utf8")).toBe("git tag v1\n");
      // Still runnable, as its hash says, and read-only, as the hub writes every revision, in folders
      // its owner can remove (#1196).
      expect((await lstat(join(revision, "scripts", "tag.sh"))).mode & 0o777).toBe(0o555);
      expect((await lstat(join(revision, "SKILL.md"))).mode & 0o777).toBe(0o444);
      expect((await lstat(revision)).mode & 0o777).toBe(0o755);
      expect((await lstat(join(revision, "scripts"))).mode & 0o777).toBe(0o755);
    }

    // Start over deletes the library too, read-only files and all.
    await wipeHubData(dataDir);
    await expect(lstat(join(dataDir, "skills"))).rejects.toThrow();
  });

  // covers ADR 029 (Backups, exports and Diagnostics), ADR 026, #1139
  it("[TC-OP-125] holds no file from ~/.agents/skills, and a restore reads the folder again for them", async () => {
    await onHub(dataDir, seed);
    const agents = join(root, "agents-skills");
    const skillFile = (name: string, text: string) =>
      writeFile(
        join(agents, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: What ${name} is for.\n---\n${text}\n`,
      );
    for (const name of ["pdf-forms", "gone"]) await mkdir(join(agents, name), { recursive: true });
    await skillFile("pdf-forms", "Fill the fields.");
    await skillFile("gone", "Soon gone.");
    const mine = join(root, "release");
    await mkdir(mine);
    await writeFile(join(mine, "SKILL.md"), "---\nname: release\ndescription: How releases go.\n---\nTag.\n");
    const skills = SkillsLive(dataDir, agents).pipe(Layer.provideMerge(SkillLibraryLive));
    const before = await onHub(
      dataDir,
      Effect.gen(function* () {
        const importer = yield* SkillImporter;
        const library = yield* SkillLibrary;
        const [release] = yield* importer.add({ _tag: "Folder", path: mine }, { by: { _tag: "You" } });
        const pdf = yield* library.byName(SkillName.make("pdf-forms"));
        if (release === undefined || pdf === null) throw new Error("nothing to back up");
        // Frodo is held on r1 while the folder moves Everyone to r2.
        const hold = { onlyWhenAsked: false, by: { _tag: "You" } } as const;
        const frodo = { _tag: "Hob", agentId: FRODO } as const;
        yield* library.assign({ ...hold, skillId: pdf.id, scope: frodo, pin: pdf.latest, held: true });
        yield* Effect.promise(() => skillFile("pdf-forms", "Fill the fields, then read them back."));
        // SkillsLive reads the folder only when it is given one, as here.
        const folder = yield* Effect.serviceOption(AgentsFolder);
        if (Option.isNone(folder)) throw new Error("the hub reads no ~/.agents/skills");
        yield* folder.value.sync;
        const revisions = yield* library.revisions(pdf.id);
        const gone = yield* library.byName(SkillName.make("gone"));
        return {
          pdf: pdf.id,
          agentsHashes: [...revisions.map((one) => one.hash), gone?.latest ?? ""],
          release: release.revision.hash,
          r2: revisions[0]?.hash,
        };
      }).pipe(Effect.provide(skills)),
    );
    const folder = join(destination, "agents.hobbots-backup");
    await backUp(dataDir, folder);
    const manifest = await readBackup(folder, knownSchemaVersion());
    expect(manifest.counts.skills).toBe(3);
    const paths = manifest.files.map((file) => file.path);
    expect(paths).toContain(`skills/${before.release}/SKILL.md`);
    for (const hash of before.agentsHashes) expect(paths.some((path) => path.includes(hash))).toBe(false);

    // On this computer the folder no longer holds one of them.
    await removeTree(join(agents, "gone"));
    await removeTree(dataDir);
    await Effect.runPromise(performRestore(dataDir, folder));
    const after = await onHub(
      dataDir,
      Effect.gen(function* () {
        const library = yield* SkillLibrary;
        const objects = yield* SkillObjects;
        const restore = Option.getOrThrow(yield* (yield* RestoreRepository).latest);
        return {
          assignments: yield* library.assignments(before.pdf),
          current: before.r2 === undefined ? null : yield* objects.folder(before.r2),
          notHere: yield* skillsNotHere,
          moves: restore.skillMoves,
        };
      }).pipe(Effect.provide(skills)),
    );
    // Every assignment and hold came back, on the folder's revision now, with its files read from it.
    expect(after.assignments.map((one) => [one.scope._tag, one.pin === before.r2, one.held]).sort()).toEqual([
      ["Everyone", true, false],
      ["Hob", true, true],
    ]);
    expect(after.current).not.toBeNull();
    expect(after.moves).toEqual([{ skill: "pdf-forms", scope: { _tag: "Hob", agentId: FRODO } }]);
    expect(after.notHere).toEqual(["gone"]);
  });

  // covers ADR 029 (Backups, exports and Diagnostics), ADR 026, #1139
  it("[TC-OP-126] leaves out an edit made in Hobbots to a folder skill, and a restore finds what the folder holds now", async () => {
    await onHub(dataDir, seed);
    const agents = join(root, "agents-skills");
    await mkdir(join(agents, "pdf-forms"), { recursive: true });
    await writeFile(
      join(agents, "pdf-forms", "SKILL.md"),
      "---\nname: pdf-forms\ndescription: What pdf-forms is for.\n---\nFill the fields.\n",
    );
    const skills = SkillsLive(dataDir, agents).pipe(Layer.provideMerge(SkillLibraryLive));
    const edit = SkillRevisionHash.make("e".repeat(64));
    const before = await onHub(
      dataDir,
      Effect.gen(function* () {
        const library = yield* SkillLibrary;
        const objects = yield* SkillObjects;
        const sql = yield* SqlClient.SqlClient;
        const pdf = yield* library.byName(SkillName.make("pdf-forms"));
        if (pdf === null) throw new Error("the folder was not read");
        // As an edit made here before folder skills were read-only left it: a revision of the folder's
        // skill with no source of its own, the newest, and Frodo held on it.
        const r1 = pdf.latest;
        const from = yield* objects.folder(r1);
        if (from === null) throw new Error("r1 has no files");
        yield* Effect.promise(() => cp(from, join(objects.root, edit), { recursive: true }));
        yield* sql`INSERT INTO skill_revisions (skill_id, hash, number, name, description, charms, files, flags,
          dropped, source_id, commit_sha, path, label, added_by, added_at)
          SELECT skill_id, ${edit}, 2, name, description, charms, files, flags, dropped, NULL, NULL, NULL, label,
          added_by, added_at FROM skill_revisions WHERE skill_id = ${pdf.id} AND hash = ${r1}`;
        yield* sql`UPDATE skills SET latest = ${edit}, revisions = 2 WHERE id = ${pdf.id}`;
        const hold = { onlyWhenAsked: false, by: { _tag: "You" } } as const;
        yield* library.assign({
          ...hold,
          skillId: pdf.id,
          scope: { _tag: "Hob", agentId: FRODO },
          pin: edit,
          held: true,
        });
        yield* library.setOptOut(FRODO, pdf.id, true);
        return { pdf: pdf.id, r1 };
      }).pipe(Effect.provide(skills)),
    );
    const folder = join(destination, "edited.hobbots-backup");
    await backUp(dataDir, folder);
    const paths = (await readBackup(folder, knownSchemaVersion())).files.map((file) => file.path);
    for (const hash of [before.r1, edit]) expect(paths.some((path) => path.includes(hash))).toBe(false);

    await removeTree(dataDir);
    await Effect.runPromise(performRestore(dataDir, folder));
    const after = await onHub(
      dataDir,
      Effect.gen(function* () {
        const library = yield* SkillLibrary;
        const found = yield* Effect.serviceOption(AgentsFolder);
        return {
          skill: yield* library.byName(SkillName.make("pdf-forms")),
          assignments: yield* library.assignments(before.pdf),
          optOuts: yield* library.optOuts(FRODO),
          current: Option.isSome(found) ? yield* found.value.current : null,
          notHere: yield* skillsNotHere,
        };
      }).pipe(Effect.provide(skills)),
    );
    // The edit stays the newest in the history, but the folder holds r1, so the skill is here and Frodo,
    // held on the edit whose files did not come back, is held on r1. His opt-out came back too.
    expect(after.skill?.latest).toBe(edit);
    expect(after.current?.get(SkillName.make("pdf-forms"))).toBe(before.r1);
    expect(after.notHere).toEqual([]);
    expect(after.assignments.map((one) => [one.scope._tag, one.pin, one.held]).sort()).toEqual([
      ["Everyone", before.r1, false],
      ["Hob", before.r1, true],
    ]);
    expect(after.optOuts.map((one) => one.skillId)).toEqual([before.pdf]);
  });

  // covers ADR 029 (Backups, exports and Diagnostics), #1139
  it("[TC-OP-127] copies only the revisions the snapshot names, so one the folder adds after it stays out", async () => {
    const objects = join(root, "objects");
    const named = "a".repeat(64);
    const later = "b".repeat(64);
    for (const hash of [named, later]) {
      await mkdir(join(objects, hash), { recursive: true });
      await writeFile(join(objects, hash, "SKILL.md"), `${hash}\n`);
    }
    const target = join(root, "copied");
    const copied = await copySkillObjects(objects, target, () => {}, new Set([named]));
    expect(copied.map((file) => file.path)).toEqual([`skills/${named}/SKILL.md`]);
    // A database too old to name its revisions keeps every one.
    const all = await copySkillObjects(objects, join(root, "all"), () => {}, null);
    expect(all.map((file) => file.path).sort()).toEqual([`skills/${named}/SKILL.md`, `skills/${later}/SKILL.md`]);
  });
});
