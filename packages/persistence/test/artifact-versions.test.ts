import { HobbotsRepository, RecordRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  ArtifactId,
  ArtifactRef,
  AttemptId,
  FileChange,
  FileChangeId,
  type JournaledEvent,
  RegisteredArtifactId,
  roleFields,
  Task,
  TaskId,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventJournal, HobbotsRepositoryLive, migrations, RecordRepositoryLive } from "../src/index.ts";
import { makeJournaledChange } from "../src/journal.ts";
import versionsMigration from "../src/migrations/0108_artifact_versions.ts";
import { TestDatabase, TestDatabaseAt } from "../src/testing.ts";

// Issue #1434 (ADR 037, Records): a file a Task returned by a relative path and its Attempt wrote in
// its folder is one artifact, one version; each artifact keeps its versions with where their
// contents are; and the rows stored twice before are merged when the hub migrates. On SQLite and
// PostgreSQL alike.

const NOW = "2026-11-12T00:00:00.000Z";
const LATER = "2026-11-12T01:00:00.000Z";
const ADA = AgentId.make("ada");
const THREAD = ThreadId.make("t1");
const TASK = TaskId.make("task-1");
const FIRST = AttemptId.make("attempt-1");
const SECOND = AttemptId.make("attempt-2");
const FOLDER = "/work/app";

const layer = Layer.mergeAll(HobbotsRepositoryLive, RecordRepositoryLive, EventJournal.layer).pipe(
  Layer.provideMerge(TestDatabase),
);

const run = <A, E>(effect: Effect.Effect<A, E, HobbotsRepository | RecordRepository | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<A, E>);

/** Journals `events` as one change, as a repository would after its own write. */
const journal = (events: ReadonlyArray<JournaledEvent>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* makeJournaledChange(sql)<null, never>(() => Effect.succeed({ value: null, events }));
  });

const task = new Task({
  id: TASK,
  ownerId: ADA,
  parentId: null,
  rootId: TASK,
  threadId: THREAD,
  brief: "Write the social post",
  state: "completed",
  dependsOn: [],
  result: { summary: "Written", attemptId: FIRST },
  currentAttemptId: FIRST,
  createdAt: NOW,
  updatedAt: NOW,
});

const change = (attemptId: AttemptId, at: string): FileChange =>
  new FileChange({
    id: FileChangeId.make(`change-${attemptId}`),
    attemptId,
    taskId: TASK,
    folder: FOLDER,
    path: "social.md",
    kind: "edited",
    movedFrom: null,
    before: null,
    after: { hash: `h-${attemptId}`, size: 1, kind: "text", contentId: null, notKept: null },
    sharedWith: [],
    settled: true,
    recordedAt: at,
  });

const changed = (attemptId: AttemptId, at: string): JournaledEvent => ({
  _tag: "FileChangesRecorded",
  attemptId,
  taskId: TASK,
  folder: FOLDER,
  changes: [change(attemptId, at)],
  removed: [],
});

/** Rows the Workbench writes, which the registry reads: a Task, its Attempts, their changes and a scan. */
const seedWork = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  const sql = yield* SqlClient.SqlClient;
  yield* repo.insertAgent(
    new Agent({
      id: ADA,
      name: "Ada",
      ...roleFields("writer"),
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 1,
      lookColor: "moss",
      configVersion: 1,
      createdAt: NOW,
    }),
  );
  yield* repo.upsertThread(new Thread({ id: THREAD, agentId: ADA, title: "Launch", createdAt: NOW, updatedAt: NOW }));
  yield* sql`INSERT INTO tasks ${sql.insert({
    id: TASK,
    owner_id: ADA,
    root_id: TASK,
    thread_id: THREAD,
    brief: "Write the social post",
    state: "active",
    created_at: NOW,
    updated_at: NOW,
  })}`;
  for (const [number, id] of [FIRST, SECOND].entries()) {
    yield* sql`INSERT INTO attempts ${sql.insert({
      id,
      task_id: TASK,
      number: number + 1,
      agent_id: ADA,
      runtime: "claude-code",
      config_version: 1,
      state: "completed",
      started_at: NOW,
    })}`;
  }
  yield* sql`INSERT INTO attempt_folder_scans ${sql.insert({
    id: "scan-1",
    attempt_id: FIRST,
    task_id: TASK,
    folder: FOLDER,
    phase: "start",
    files_scanned: 1,
    started_at: NOW,
    ended_at: NOW,
  })}`;
});

/** The Workbench's row of an Attempt's change, with the contents it kept. */
const keptChange = (attemptId: AttemptId, contentId: string, at: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO attempt_file_changes ${sql.insert({
      id: `change-${attemptId}`,
      attempt_id: attemptId,
      task_id: TASK,
      folder: FOLDER,
      path: "social.md",
      kind: "edited",
      after_content_id: contentId,
      settled: 1,
      recorded_at: at,
    })}`;
  });

describe("artifact versions", () => {
  // covers ADR 037 (Records: Artifact), #1434
  it("[TC-CH-1434-01] keeps a file a Task returned by a relative path and its Attempt wrote as one artifact, one version for the Attempt", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seedWork;
        const records = yield* RecordRepository;
        // The Task returns `social.md` before its Attempt's last scan records the change.
        const returned = new ArtifactRef({
          id: ArtifactId.make("ref-1"),
          taskId: TASK,
          attemptId: FIRST,
          kind: "file",
          label: "Social post",
          value: "./social.md",
          createdAt: NOW,
        });
        yield* journal([{ _tag: "TaskCompleted", task, artifacts: [returned] }]);
        yield* keptChange(FIRST, "content-1", NOW);
        yield* journal([changed(FIRST, NOW)]);
        // A later Attempt changes it again.
        yield* keptChange(SECOND, "content-2", LATER);
        yield* journal([changed(SECOND, LATER)]);
        const artifacts = yield* records.listArtifacts(THREAD);
        const id = artifacts[0]?.id ?? RegisteredArtifactId.make("none");
        return {
          artifacts,
          versions: yield* records.artifactVersions(THREAD, id),
          elsewhere: yield* records.artifactVersions(ThreadId.make("other"), id),
        };
      }),
    );
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      locator: `${FOLDER}/social.md`,
      title: "Social post",
      latestVersion: 2,
    });
    const versions = Option.getOrThrow(result.versions).versions;
    expect(versions.map((each) => [each.version, each.origin.kind, each.source])).toEqual([
      [1, "attempt", { _tag: "kept", attemptId: FIRST, contentId: "content-1" }],
      [2, "attempt", { _tag: "kept", attemptId: SECOND, contentId: "content-2" }],
    ]);
    expect(Option.isNone(result.elsewhere)).toBe(true);
  });

  // covers ADR 037 (Records: Artifact), DP-003, #1434
  it("[TC-CH-1434-02] merges a file stored twice, by its relative path and in its folder, when the hub migrates", async () => {
    const earlier = Object.fromEntries(Object.entries(migrations).filter(([id]) => id < "0108")) as typeof migrations;
    const result = await Effect.gen(function* () {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms();
      yield* sql`INSERT INTO agents ${sql.insert({
        id: ADA,
        name: "Ada",
        runtime: "claude-code",
        role_title: "Guide",
        instructions: "",
        look_seed: 1,
        look_color: "moss",
        created_at: NOW,
      })}`;
      yield* sql`INSERT INTO threads ${sql.insert({ id: THREAD, agent_id: ADA, title: "Launch", created_at: NOW, updated_at: NOW })}`;
      yield* sql`INSERT INTO chapters ${sql.insert({ id: "c1", thread_id: THREAD, number: 1, state: "live", started_at: NOW })}`;
      yield* sql`INSERT INTO tasks ${sql.insert({
        id: TASK,
        owner_id: ADA,
        root_id: TASK,
        thread_id: THREAD,
        brief: "Write the social post",
        state: "completed",
        created_at: NOW,
        updated_at: NOW,
      })}`;
      yield* sql`INSERT INTO attempts ${sql.insert({
        id: FIRST,
        task_id: TASK,
        number: 1,
        agent_id: ADA,
        runtime: "claude-code",
        config_version: 1,
        state: "completed",
        started_at: NOW,
      })}`;
      yield* sql`INSERT INTO artifact_refs ${sql.insert({
        id: "ref-1",
        task_id: TASK,
        attempt_id: FIRST,
        kind: "file",
        label: "Social post",
        value: "social.md",
        created_at: LATER,
      })}`;
      yield* sql`INSERT INTO attempt_file_changes ${sql.insert({
        id: "change-1",
        attempt_id: FIRST,
        task_id: TASK,
        folder: FOLDER,
        path: "social.md",
        kind: "added",
        after_content_id: "content-1",
        settled: 1,
        recorded_at: NOW,
      })}`;
      const row = (id: string, locator: string, title: string, origin: string, review: string, at: string) => ({
        id,
        thread_id: THREAD,
        chapter_id: "c1",
        kind: "doc",
        title,
        locator,
        latest_version: 1,
        origin_kind: origin,
        origin_id: origin === "attempt" ? FIRST : "ref-1",
        actor_kind: "hob",
        actor_id: ADA,
        created_at: at,
        updated_at: at,
        review,
        reviewed_at: review === "waiting" ? null : LATER,
        reviewed_by_kind: review === "waiting" ? null : "user",
        reviewed_by_id: review === "waiting" ? null : "owner",
        revision: 1,
      });
      yield* sql`INSERT INTO artifacts ${sql.insert(row("written", `${FOLDER}/social.md`, "social.md", "attempt", "waiting", NOW))}`;
      yield* sql`INSERT INTO artifacts ${sql.insert(row("returned", "social.md", "Social post", "task-artifact", "reviewed", LATER))}`;
      yield* sql`INSERT INTO artifact_sightings ${sql.insert({ artifact_id: "written", origin_kind: "attempt", origin_id: FIRST })}`;
      yield* sql`INSERT INTO artifact_sightings ${sql.insert({ artifact_id: "returned", origin_kind: "task-artifact", origin_id: "ref-1" })}`;
      for (const [id, locator] of [
        ["written", `${FOLDER}/social.md`],
        ["returned", "social.md"],
      ] as const) {
        yield* sql`INSERT INTO find_records ${sql.insert({
          kind: "artifact",
          record_id: id,
          thread_id: THREAD,
          chapter_id: "c1",
          title: id,
          detail: locator,
          body: `${id} ${locator}`,
          artifact_kind: "doc",
          version: 1,
          at: NOW,
          indexed_sequence: 0,
        })}`;
      }
      yield* versionsMigration;
      return {
        artifacts: yield* sql<
          Record<string, unknown>
        >`SELECT id, locator, title, latest_version, review, reviewed_by_kind
          FROM artifacts ORDER BY id`,
        sightings: yield* sql<Record<string, unknown>>`SELECT artifact_id, origin_kind, attempt_id, version, seen_at
          FROM artifact_sightings ORDER BY origin_kind`,
        found: yield* sql<
          Record<string, unknown>
        >`SELECT record_id, title, detail FROM find_records ORDER BY record_id`,
      };
    }).pipe(Effect.provide(TestDatabaseAt(earlier)), Effect.scoped, Effect.runPromise);
    expect(result.artifacts.map((row) => ({ ...row, latest_version: Number(row.latest_version) }))).toEqual([
      {
        id: "written",
        locator: `${FOLDER}/social.md`,
        title: "Social post",
        latest_version: 1,
        // The review you settled on the row merged away is carried over.
        review: "reviewed",
        reviewed_by_kind: "user",
      },
    ]);
    expect(result.sightings.map((row) => ({ ...row, version: Number(row.version) }))).toEqual([
      { artifact_id: "written", origin_kind: "attempt", attempt_id: FIRST, version: 1, seen_at: NOW },
      { artifact_id: "written", origin_kind: "task-artifact", attempt_id: FIRST, version: 1, seen_at: LATER },
    ]);
    expect(result.found).toEqual([{ record_id: "written", title: "Social post", detail: `${FOLDER}/social.md` }]);
  });
});
