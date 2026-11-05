import { HobbotsRepository, MemoryShareLog } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  MemoryPath,
  MemoryProjectIdentity,
  MemoryShare,
  MemoryVersion,
  MessageId,
  ThreadId,
} from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventJournal, HobbotsRepositoryLive, MemoryShareLogLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

// #960: the record of what hobs ask to share (ADR 028, Sharing), which keeps a retried key to one
// share and lets only the first of two racing decisions land.

const TestLayer = Layer.mergeAll(HobbotsRepositoryLive, MemoryShareLogLive, EventJournal.layer).pipe(
  Layer.provideMerge(TestDatabase),
);
const run = <A, E>(
  effect: Effect.Effect<A, E, HobbotsRepository | MemoryShareLog | EventJournal | SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(TestLayer), Effect.runPromise);

const now = "2026-11-05T00:00:00.000Z";
const later = "2026-11-05T00:05:00.000Z";
const ada = AgentId.make("ada");

const seed = HobbotsRepository.use((repo) =>
  repo.insertAgent(
    new Agent({
      id: ada,
      name: "Ada",
      roleTitle: "Builder",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 1,
      lookColor: "moss",
      configVersion: 1,
      createdAt: now,
    }),
  ),
);

const share = (key: string, overrides: Partial<MemoryShare> = {}) =>
  new MemoryShare({
    id: `${key}-id`,
    agentId: ada,
    work: "reply:m1",
    key,
    input: "input-digest",
    scope: { _tag: "Project", identity: MemoryProjectIdentity.make("github.com/me/site") },
    path: MemoryPath.make("howto/deploy.md"),
    markdown: "# Deploy\n\nRun `pnpm deploy`.",
    tags: ["deploy"],
    state: "waiting",
    pending: null,
    through: "review",
    edited: false,
    version: null,
    previous: null,
    threadId: ThreadId.make("t1"),
    messageId: MessageId.make("m1"),
    createdAt: now,
    updatedAt: now,
    decidedAt: null,
    ...overrides,
  });

describe("memory share records", () => {
  // covers ADR 028 (Sharing), #960
  it("[TC-DP-270] records and journals a share once per key, as the hob that asked", () =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const log = yield* MemoryShareLog;
        const started = yield* log.begin(share("deploy"));
        expect(started._tag).toBe("Started");
        if (started._tag !== "Started") return;
        expect(started.entries.map((entry) => entry.type)).toEqual(["MemoryShareRequested"]);
        expect(started.entries[0]?.correlation).toMatchObject({ agentId: ada, threadId: "t1", messageId: "m1" });
        // A retry, with a fresh id, finds the first share; so does one from the Task the reply started.
        expect(yield* log.begin(share("deploy", { id: "again" }))).toMatchObject({
          _tag: "Existing",
          share: { id: "deploy-id" },
        });
        const moved = yield* log.begin(share("deploy", { id: "moved", work: "task:k1" }), "reply:m1");
        expect(moved._tag).toBe("Existing");
        // The same key is free in other work.
        expect((yield* log.begin(share("deploy", { id: "other", work: "task:k2" })))._tag).toBe("Started");
        expect(Option.getOrThrow(yield* log.get("deploy-id"))).toEqual(share("deploy"));
      }),
    ));

  // covers ADR 028 (Sharing), #960
  it("[TC-DP-271] moves a share only from the state it expects, so the first of two decisions lands", () =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const log = yield* MemoryShareLog;
        yield* log.begin(share("deploy"));
        const sending = share("deploy", { state: "sending", pending: "share", updatedAt: later });
        const claimed = yield* log.move(sending, ["waiting"]);
        expect(Option.map(claimed, (moved) => moved.entries.map((entry) => entry.type))).toEqual(
          Option.some(["MemoryShareChanged"]),
        );
        // A second decision, which also expected it waiting, finds it moved on.
        expect(Option.isNone(yield* log.move(share("deploy", { state: "kept" }), ["waiting"]))).toBe(true);
        const shared = share("deploy", {
          state: "shared",
          edited: true,
          markdown: "# Deploy\n\nRun `pnpm deploy:prod`.",
          version: MemoryVersion.make("v2"),
          previous: MemoryVersion.make("v1"),
          updatedAt: later,
          decidedAt: later,
        });
        yield* log.move(shared, ["sending"]);
        expect(Option.getOrThrow(yield* log.get("deploy-id"))).toEqual(shared);
      }),
    ));

  // covers ADR 028 (Sharing), #960
  it("[TC-DP-272] lists what waits oldest first, then the latest decided, and refuses a state it does not know", () =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const log = yield* MemoryShareLog;
        yield* log.begin(share("b", { createdAt: later, updatedAt: later }));
        yield* log.begin(share("a"));
        yield* log.begin(share("c"));
        yield* log.begin(share("d"));
        yield* log.move(share("c", { state: "kept", updatedAt: "2026-11-05T00:01:00.000Z" }), ["waiting"]);
        yield* log.move(share("d", { state: "kept", updatedAt: "2026-11-05T00:02:00.000Z" }), ["waiting"]);
        expect((yield* log.list(1)).map((each) => each.key)).toEqual(["a", "b", "d"]);
        expect((yield* log.list(0)).map((each) => each.key)).toEqual(["a", "b"]);
        const sql = yield* SqlClient.SqlClient;
        const failed = yield* Effect.exit(sql`UPDATE memory_shares SET state = 'lost'`);
        expect(failed._tag).toBe("Failure");
      }),
    ));
});
