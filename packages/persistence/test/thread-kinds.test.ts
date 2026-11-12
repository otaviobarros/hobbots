import { HobbotsRepository } from "@hobbots/agents";
import { AgentId, Thread, ThreadId } from "@hobbots/domain";
import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventJournal, HobbotsRepositoryLive, migrations } from "../src/index.ts";
import threadKinds from "../src/migrations/0095_thread_kinds.ts";
import chapters from "../src/migrations/0099_chapters.ts";
import projectorCursors from "../src/migrations/0100_projector_cursors.ts";
import campSuggestions from "../src/migrations/0102_camp_suggestions.ts";
import { TestDatabaseAt } from "../src/testing.ts";

// Issue #1375 (ADR 037): a thread is a chat or a camp. The migration makes each hob's most recent open
// thread its chat and every other thread a camp with its title, and the database then refuses a second
// open chat for a hob, on SQLite and PostgreSQL alike.

const NOW = "2026-11-10T00:00:00.000Z";
const at = (minute: number) => new Date(Date.UTC(2026, 10, 10, 0, minute)).toISOString();

/** The migrations that ran before 0095, when threads had no kind. */
const earlier = Object.fromEntries(Object.entries(migrations).filter(([id]) => id < "0095")) as typeof migrations;

const storedHob = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fields = { roleTitle: "Guide", instructions: "", lookSeed: 1, lookColor: "moss", createdAt: NOW };
    yield* sql`INSERT INTO agents ${sql.insert({ id, name: id, runtime: "claude-code", ...fields })}`;
  });

interface Old {
  readonly id: string;
  readonly agentId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
  readonly skillTrial?: boolean;
}

let sequence = 0;

/** A thread and its ThreadUpserted entry, as the hub stored them before 0095. */
const storedThread = (old: Old) =>
  Effect.gen(function* () {
    const sql = (yield* SqlClient.SqlClient).withoutTransforms();
    const skillTrial =
      old.skillTrial === true
        ? {
            name: "lamps",
            description: "Lights lamps",
            hash: "a".repeat(64),
            skillId: null,
            base: null,
            proposalId: null,
          }
        : null;
    yield* sql`INSERT INTO threads ${sql.insert({
      id: old.id,
      agent_id: old.agentId,
      title: old.title,
      sessions: "[]",
      archived_at: old.archivedAt ?? null,
      skill_trial: skillTrial === null ? null : JSON.stringify(skillTrial),
      created_at: NOW,
      updated_at: old.updatedAt,
      revision: 1,
    })}`;
    sequence += 1;
    const thread = {
      id: old.id,
      agentId: old.agentId,
      title: old.title,
      sessions: [],
      brain: null,
      archivedAt: old.archivedAt ?? null,
      lastLine: null,
      pinnedAt: null,
      unread: false,
      skillTrial,
      createdAt: NOW,
      updatedAt: old.updatedAt,
      revision: 1,
    };
    yield* sql`INSERT INTO event_journal ${sql.insert({
      sequence,
      id: `event-${sequence}`,
      type: "ThreadUpserted",
      schema_version: 3,
      occurred_at: NOW,
      agent_id: old.agentId,
      thread_id: old.id,
      payload: JSON.stringify({ _tag: "ThreadUpserted", thread }),
    })}`;
    yield* sql`UPDATE event_journal_head SET sequence = ${sequence}`;
  });

const kindsOf = (threads: ReadonlyArray<Thread>) =>
  Object.fromEntries(threads.map((thread) => [thread.id, [thread.kind, thread.state, thread.title]]));

const layer = Layer.mergeAll(HobbotsRepositoryLive, EventJournal.layer).pipe(
  Layer.provideMerge(TestDatabaseAt(earlier)),
);

describe("0095_thread_kinds", () => {
  // covers CH-009, DP-003
  it("[TC-DP-1269] makes each hob's most recent open thread its chat and every other thread a camp with its title", async () => {
    sequence = 0;
    const result = await Effect.gen(function* () {
      for (const hob of ["ada", "bo", "cy", "di"]) yield* storedHob(hob);
      // Ada's newest thread is archived and her newest open one a skill trial; neither is her chat.
      yield* storedThread({ id: "ada-old", agentId: "ada", title: "Old plans", updatedAt: at(1) });
      yield* storedThread({ id: "ada-recent", agentId: "ada", title: "Lamps", updatedAt: at(5) });
      yield* storedThread({
        id: "ada-trial",
        agentId: "ada",
        title: "Try Lamps",
        updatedAt: at(8),
        skillTrial: true,
      });
      yield* storedThread({
        id: "ada-archived",
        agentId: "ada",
        title: "Done",
        updatedAt: at(9),
        archivedAt: at(9),
      });
      // Bo has only an archived thread, so no chat.
      yield* storedThread({ id: "bo-1", agentId: "bo", title: "Gone", updatedAt: at(2), archivedAt: at(3) });
      // Cy's two threads tie on their last activity; the one listed first, by id, is the chat.
      yield* storedThread({ id: "cy-b", agentId: "cy", title: "B", updatedAt: at(4) });
      yield* storedThread({ id: "cy-a", agentId: "cy", title: "A", updatedAt: at(4) });
      // Di has only a skill trial, which stays a camp.
      yield* storedThread({ id: "di-trial", agentId: "di", title: "Try", updatedAt: at(1), skillTrial: true });

      yield* threadKinds;
      // The repository reads each thread's live chapter, which 0099 adds.
      yield* chapters;

      const repo = yield* HobbotsRepository;
      const threads: Array<Thread> = [];
      for (const hob of ["ada", "bo", "cy", "di"]) {
        threads.push(...(yield* repo.listThreads(AgentId.make(hob))));
        threads.push(...(yield* repo.listArchivedThreads(AgentId.make(hob))));
      }
      const journal = yield* EventJournal;
      const entries = yield* journal.readAfter(0);
      return { threads, entries };
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(kindsOf(result.threads)).toEqual({
      "ada-old": ["camp", "open", "Old plans"],
      "ada-recent": ["chat", "open", "Lamps"],
      "ada-trial": ["camp", "open", "Try Lamps"],
      "ada-archived": ["camp", "archived", "Done"],
      "bo-1": ["camp", "archived", "Gone"],
      "cy-a": ["chat", "open", "A"],
      "cy-b": ["camp", "open", "B"],
      "di-trial": ["camp", "open", "Try"],
    });
    expect(result.threads.every((thread) => thread.goal === null && !thread.private && thread.origin === null)).toBe(
      true,
    );
    // Each journaled thread decodes with the kind it has now and the state its own entry said.
    // 0099 then took each entry on to version 5, with its chapter.
    expect(result.entries.map((entry) => entry.schemaVersion)).toEqual(result.entries.map(() => 5));
    const journaled = kindsOf(
      result.entries.flatMap((entry) => (entry.payload._tag === "ThreadUpserted" ? [entry.payload.thread] : [])),
    );
    expect(journaled).toEqual(kindsOf(result.threads));
  });

  // covers CH-009, DP-003
  it("[TC-DP-1270] refuses a second open chat for a hob in the database, and takes an archived one or another hob's", async () => {
    sequence = 0;
    const result = await Effect.gen(function* () {
      yield* storedHob("ada");
      yield* storedHob("bo");
      yield* storedThread({ id: "ada-chat", agentId: "ada", title: "Lamps", updatedAt: at(1) });
      yield* threadKinds;
      // The repository reads each thread's live chapter, which 0099 adds, and a closed thread's
      // camp suggestions expire, which 0102 keeps (after 0100's projector cursors).
      yield* chapters;
      yield* projectorCursors;
      yield* campSuggestions;

      const repo = yield* HobbotsRepository;
      const thread = (id: string, agentId: string, fields: Partial<Thread> = {}) =>
        new Thread({
          id: ThreadId.make(id),
          agentId: AgentId.make(agentId),
          title: id,
          kind: "chat",
          createdAt: NOW,
          updatedAt: NOW,
          revision: 0 as Thread["revision"],
          ...fields,
        });
      const second = yield* Effect.exit(repo.upsertThread(thread("ada-second", "ada")));
      const archived = yield* Effect.exit(
        repo.upsertThread(thread("ada-archived", "ada", { state: "archived", archivedAt: NOW })),
      );
      const camp = yield* Effect.exit(repo.upsertThread(thread("ada-camp", "ada", { kind: "camp" })));
      const others = yield* Effect.exit(repo.upsertThread(thread("bo-chat", "bo")));
      // Bringing the archived chat back while the first is open is refused too.
      const restored = yield* Effect.exit(
        repo.upsertThread(thread("ada-archived", "ada", { state: "open", archivedAt: null })),
      );
      const sql = yield* SqlClient.SqlClient;
      const raw = yield* Effect.exit(
        sql`INSERT INTO threads ${sql.insert({
          id: "ada-raw",
          agentId: "ada",
          title: "Raw",
          kind: "chat",
          state: "open",
          createdAt: NOW,
          updatedAt: NOW,
          revision: 1,
        })}`,
      );
      const stored = yield* repo.findThread(ThreadId.make("ada-second"));
      return { second, archived, camp, others, restored, raw, stored };
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(Exit.isFailure(result.second)).toBe(true);
    expect(Exit.isFailure(result.restored)).toBe(true);
    expect(Exit.isFailure(result.raw)).toBe(true);
    expect(Option.isNone(result.stored)).toBe(true);
    expect(Exit.isSuccess(result.archived)).toBe(true);
    expect(Exit.isSuccess(result.camp)).toBe(true);
    expect(Exit.isSuccess(result.others)).toBe(true);
  });
});
