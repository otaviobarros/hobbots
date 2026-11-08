import { HobbotsRepository, HubQuestionRepository } from "@hobbots/agents";
import { Agent, AgentId, DeviceId, HubQuestionId, Thread, ThreadId } from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import type { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventJournal, HobbotsRepositoryLive, HubQuestionRepositoryLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

// Issue #976: a question the hub itself asks keeps what it asks, the chat it concerns, its choices
// and your answer, on SQLite and PostgreSQL alike. Issue #1045: what it asks is codes and data, and
// its choices are keys, picked by key.

const TestLayer = Layer.mergeAll(HubQuestionRepositoryLive, HobbotsRepositoryLive, EventJournal.layer).pipe(
  Layer.provideMerge(TestDatabase),
);
const run = <A, E>(
  effect: Effect.Effect<A, E, HubQuestionRepository | HobbotsRepository | EventJournal | SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(TestLayer), Effect.runPromise);

const NOW = "2026-11-05T10:00:00.000Z";
const LATER = "2026-11-05T10:05:00.000Z";
const FRODO = AgentId.make("frodo");
const CHAT = ThreadId.make("first-run");
const DEVICE = DeviceId.make("window");
const ask = {
  kind: "commit-identity",
  reason: "no-git-identity",
  github: { login: "frodo", identity: { name: "Frodo", email: "1+frodo@users.noreply.github.com" } },
  unread: null,
} as const;
const options = ["github", "own-git"];

const seed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(
    new Agent({
      id: FRODO,
      name: "Frodo",
      roleTitle: "Lead",
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
  yield* repo.upsertThread(
    new Thread({ id: CHAT, agentId: FRODO, title: "First run", createdAt: NOW, updatedAt: NOW }),
  );
});

const raise = (id: string, chat = true) =>
  Effect.flatMap(HubQuestionRepository, (questions) =>
    questions.raise({
      id: HubQuestionId.make(id),
      key: "default",
      ...(chat ? { chat: { agentId: FRODO, threadId: CHAT } } : {}),
      ask,
      options,
      recommended: "github",
      createdAt: NOW,
    }),
  );

describe("HubQuestionRepository", () => {
  // covers OR-004, DP-003
  it("[TC-DP-260] keeps what a hub question asks, its chat and choices, and journals it once per thing it asks about", async () => {
    const { raised, again, read, open, events } = await run(
      Effect.gen(function* () {
        yield* seed;
        const questions = yield* HubQuestionRepository;
        const raised = yield* raise("q1");
        const again = yield* raise("q2");
        const read = yield* questions.find(HubQuestionId.make("q1"));
        const head = yield* (yield* EventJournal).readAfter(0);
        return { raised, again, read, open: yield* questions.listOpen, events: head };
      }),
    );
    expect(raised.value).toMatchObject({
      id: "q1",
      key: "default",
      ask,
      chat: { agentId: FRODO, threadId: CHAT },
      options,
      recommended: "github",
      state: "open",
      picked: null,
    });
    // An open question about the same thing stands: no second question, no second event.
    expect(again.value.id).toBe("q1");
    expect(again.entries).toHaveLength(0);
    expect(Option.getOrThrow(read)).toEqual(raised.value);
    expect(open.map((each) => each.id)).toEqual(["q1"]);
    const journaled = events.filter((each) => each.type.startsWith("HubQuestion"));
    expect(journaled).toHaveLength(1);
    expect(journaled[0]?.correlation).toMatchObject({ agentId: FRODO, threadId: CHAT });
  });

  // covers OR-004, DP-003
  it("[TC-DP-261] records a picked choice by its key, a typed answer as typed, and what the hub applied", async () => {
    const result = await run(
      Effect.gen(function* () {
        const questions = yield* HubQuestionRepository;
        yield* raise("picked", false);
        const from = { deviceId: DEVICE, via: "inbox" } as const;
        // A choice the question does not offer is refused, and the question stays open.
        const unknown = yield* questions
          .answer(HubQuestionId.make("picked"), { picked: "nightly" }, LATER, from)
          .pipe(Effect.flip);
        const picked = yield* questions.answer(HubQuestionId.make("picked"), { picked: "github" }, LATER, from);
        const twice = yield* questions
          .answer(HubQuestionId.make("picked"), { words: "again" }, LATER, from)
          .pipe(Effect.flip);
        const missing = yield* questions
          .answer(HubQuestionId.make("nope"), { words: "again" }, LATER, from)
          .pipe(Effect.flip);
        yield* questions.raise({
          id: HubQuestionId.make("typed"),
          key: "other",
          ask,
          options,
          createdAt: LATER,
        });
        // Typed words that read like a choice stay words: only a key picks one.
        const typed = yield* questions.answer(HubQuestionId.make("typed"), { words: "github" }, LATER, {
          deviceId: DEVICE,
          via: "chat",
        });
        const unapplied = yield* questions.listUnapplied("commit-identity");
        yield* questions.markApplied(HubQuestionId.make("picked"), LATER);
        const left = yield* questions.listUnapplied("commit-identity");
        const read = yield* questions.find(HubQuestionId.make("typed"));
        return { unknown, picked, twice, missing, typed, unapplied, left, read, open: yield* questions.listOpen };
      }),
    );
    expect(result.unknown.reason).toBe("unknown-choice");
    expect(result.picked.value).toMatchObject({
      state: "answered",
      answer: null,
      picked: "github",
      answeredAt: LATER,
      answeredByDeviceId: DEVICE,
      answeredVia: "inbox",
      chat: null,
    });
    expect(result.picked.entries.map((each) => each.type)).toEqual(["HubQuestionAnswered"]);
    expect(result.twice.reason).toBe("closed");
    expect(result.missing.reason).toBe("missing");
    expect(result.typed.value).toMatchObject({ answer: "github", picked: null, answeredVia: "chat" });
    expect(Option.getOrThrow(result.read)).toEqual(result.typed.value);
    expect(result.unapplied.map((each) => each.id)).toEqual(["picked", "typed"]);
    expect(result.left.map((each) => each.id)).toEqual(["typed"]);
    expect(result.open).toEqual([]);
  });

  // covers OR-004
  it("[TC-DP-262] withdraws an open question once, and a new one about the same thing can be raised after", async () => {
    const result = await run(
      Effect.gen(function* () {
        const questions = yield* HubQuestionRepository;
        yield* raise("first", false);
        const withdrawn = yield* questions.withdraw(HubQuestionId.make("first"));
        const twice = yield* questions.withdraw(HubQuestionId.make("first"));
        const next = yield* raise("second", false);
        return { withdrawn, twice, next, open: yield* questions.listOpen };
      }),
    );
    expect(Option.getOrThrow(result.withdrawn).value.state).toBe("withdrawn");
    expect(Option.isNone(result.twice)).toBe(true);
    expect(result.next.value.id).toBe("second");
    expect(result.open.map((each) => each.id)).toEqual(["second"]);
  });
});
