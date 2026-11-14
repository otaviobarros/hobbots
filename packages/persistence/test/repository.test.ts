import { HobbotsRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  type ChangeActor,
  ChapterId,
  Message,
  MessageId,
  OWNER_ACTOR,
  roleFields,
  TaskId,
  Thread,
  ThreadId,
  YOU,
} from "@hobbots/domain";
import { HobbotsRepositoryLive } from "@hobbots/persistence";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { TestDatabase } from "../src/testing.ts";

const TestLayer = HobbotsRepositoryLive.pipe(Layer.provide(TestDatabase));
const now = "2026-10-28T00:00:00.000Z";
const agentId = AgentId.make("aldric");
const threadId = ThreadId.make("t1");

const message = (id: string, status: Message["status"] = "complete") =>
  new Message({
    id: MessageId.make(id),
    threadId,
    role: "assistant",
    content: id,
    status,
    error: null,
    configVersion: 1,
    createdAt: now,
  });

describe("HobbotsRepository", () => {
  // covers DP-003, CH-002
  it("[TC-DP-004] round-trips agents, threads and ordered messages", async () => {
    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      yield* repo.insertAgent(
        new Agent({
          id: agentId,
          name: "Aldric",
          roleTitle: "Guide",
          runtime: "claude-code",
          model: null,
          effort: null,
          instructions: "",
          lookSeed: 1234,
          lookColor: "moss",
          configVersion: 1,
          createdAt: now,
        }),
      );
      yield* repo.upsertThread(
        new Thread({
          id: threadId,
          agentId,
          title: "New thread",
          createdAt: now,
          updatedAt: now,
        }),
      );
      yield* repo.upsertThread(
        new Thread({
          id: threadId,
          agentId,
          title: "Renamed",
          sessions: [
            {
              runtime: "claude-code",
              agentId,
              sessionId: "s1",
              chapterId: ChapterId.make("chapter-1"),
              seenThrough: null,
            },
          ],
          brain: { runtime: "codex", model: "gpt", effort: null },
          createdAt: now,
          updatedAt: now,
        }),
      );
      yield* repo.upsertMessage(message("b"));
      yield* repo.upsertMessage(message("a", "streaming"));
      yield* repo.upsertMessage(message("c", "stopping"));
      yield* repo.upsertMessage(new Message({ ...message("b"), content: "b2" }));
      const unfinished = yield* repo.listUnfinishedMessages;
      return {
        agents: yield* repo.listAgents,
        thread: yield* repo.findThread(threadId),
        messages: yield* repo.listMessages(threadId),
        unfinished,
      };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect(result.agents.map((a) => [a.name, a.lookSeed, a.lookColor])).toEqual([["Aldric", 1234, "moss"]]);
    expect(Option.getOrThrow(result.thread)).toMatchObject({
      title: "Renamed",
      sessions: [
        { runtime: "claude-code", sessionId: "s1", chapterId: ChapterId.make("chapter-1"), seenThrough: null },
      ],
      brain: { runtime: "codex", model: "gpt", effort: null },
    });
    expect(result.messages.map((m) => [m.id, m.content, m.status])).toEqual([
      ["b", "b2", "complete"],
      ["a", "a", "streaming"],
      ["c", "c", "stopping"],
    ]);
    expect(result.unfinished.map((m) => m.id)).toEqual(["a", "c"]);
  });

  // covers CH-002, UX-001
  it("[TC-DP-241] reads each thread's last shown message as one line, skipping queued and empty ones", async () => {
    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      yield* repo.insertAgent(
        new Agent({
          id: agentId,
          name: "Aldric",
          roleTitle: "Guide",
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
      const upserted = yield* repo.upsertThread(
        new Thread({ id: threadId, agentId, title: "Plan", createdAt: now, updatedAt: now }),
      );
      const empty = { list: (yield* repo.listThreads(agentId))[0]?.lastLine, upserted: upserted.value.lastLine };
      yield* repo.upsertMessage(new Message({ ...message("m1"), content: "Done.\n\nThe copy is in\tdocs/launch.md" }));
      // A reply made only of tool calls has no text, and a queued message is not in the transcript yet.
      yield* repo.upsertMessage(new Message({ ...message("m2"), content: "  " }));
      yield* repo.upsertMessage(
        new Message({ ...message("m3", "queued"), role: "user", actor: OWNER_ACTOR, configVersion: null }),
      );
      const shown = (yield* repo.listThreads(agentId))[0]?.lastLine;
      yield* repo.upsertMessage(new Message({ ...message("m4"), content: "word ".repeat(60) }));
      const long = Option.getOrThrow(yield* repo.findThread(threadId)).lastLine;
      const touched = yield* repo.upsertThread(
        new Thread({ id: threadId, agentId, title: "Plan", createdAt: now, updatedAt: now }),
      );
      return { empty, shown, long, touched: touched.value.lastLine };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect(result.empty).toEqual({ list: null, upserted: null });
    expect(result.shown).toBe("Done. The copy is in docs/launch.md");
    expect(result.long).toHaveLength(140);
    expect(result.long?.endsWith("word…")).toBe(true);
    // A thread written again carries the line a read shows, so its event does not blank it.
    expect(result.touched).toBe(result.long);
  });

  // covers UX-006, DP-003
  it("[TC-DP-250] keeps how far you read a thread, unread once the hob writes past it, and moves it only forward", async () => {
    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      yield* repo.insertAgent(
        new Agent({
          id: agentId,
          name: "Aldric",
          roleTitle: "Guide",
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
      yield* repo.upsertThread(new Thread({ id: threadId, agentId, title: "Plan", createdAt: now, updatedAt: now }));
      const unread = () => repo.listUnreadThreads.pipe(Effect.map((listed) => listed.threadIds.includes(threadId)));
      const asked = new Message({ ...message("m1"), role: "user", actor: OWNER_ACTOR, configVersion: null });
      yield* repo.upsertMessage(asked);
      const yours = yield* unread();
      // A reply under way leaves the thread read until it ends.
      yield* repo.upsertMessage(message("m2", "streaming"));
      const streaming = yield* unread();
      const seen = (yield* repo.upsertMessage(message("m2"))).value.revision;
      const ended = yield* unread();
      const listed = (yield* repo.listUnreadThreads).threadIds;
      const marked = yield* repo.markThreadRead(threadId, MessageId.make("m2"), seen);
      const after = yield* unread();
      // Reading an older message, again or a message of another thread changes nothing.
      const back = yield* repo.markThreadRead(threadId, MessageId.make("m1"), seen);
      const again = yield* repo.markThreadRead(threadId, MessageId.make("m2"), seen);
      const elsewhere = yield* repo.markThreadRead(threadId, MessageId.make("nope"), seen);
      // A write of the thread keeps the marker, and a failed reply with no text is unread too.
      yield* repo.upsertThread(new Thread({ id: threadId, agentId, title: "Renamed", createdAt: now, updatedAt: now }));
      const kept = yield* unread();
      yield* repo.upsertMessage(new Message({ ...message("m3", "failed"), content: "" }));
      return {
        yours,
        streaming,
        ended,
        listed,
        marked: Option.map(marked, (c) => ({
          reader: c.value.actor,
          read: c.value.readRevision,
          events: c.entries.map((e) => e.type),
        })),
        seen,
        after,
        back: Option.isNone(back),
        again: Option.isNone(again),
        elsewhere: Option.isNone(elsewhere),
        kept,
        failed: yield* unread(),
      };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect(result).toEqual({
      yours: false,
      streaming: false,
      ended: true,
      listed: [threadId],
      marked: Option.some({ reader: OWNER_ACTOR, read: result.seen, events: ["ThreadMemberChanged"] }),
      seen: result.seen,
      after: false,
      back: true,
      again: true,
      elsewhere: true,
      kept: false,
      failed: true,
    });
  });

  // covers UX-006, DP-003
  it("[TC-DP-273] keeps a lead's quiet reply with its text, out of the thread's last line and its unread dot (#1006)", async () => {
    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      yield* repo.insertAgent(
        new Agent({
          id: agentId,
          name: "Aldric",
          roleTitle: "Guide",
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
      yield* repo.upsertThread(new Thread({ id: threadId, agentId, title: "Plan", createdAt: now, updatedAt: now }));
      const plan = (yield* repo.upsertMessage(new Message({ ...message("m1"), content: "Quill drafts the copy." })))
        .value;
      yield* repo.markThreadRead(threadId, plan.id, plan.revision);
      yield* repo.upsertMessage(
        new Message({ ...message("m2"), content: "Quill finished; I wait on Ada.", quiet: true }),
      );
      const quiet = Option.getOrThrow(yield* repo.findThread(threadId));
      const quietUnread = (yield* repo.listUnreadThreads).threadIds.includes(threadId);
      yield* repo.upsertMessage(new Message({ ...message("m3"), content: "The launch page is live." }));
      const finish = Option.getOrThrow(yield* repo.findThread(threadId));
      const finishUnread = (yield* repo.listUnreadThreads).threadIds.includes(threadId);
      return {
        quiet,
        quietUnread,
        finish,
        finishUnread,
        stored: (yield* repo.listMessages(threadId)).map((each) => [each.id, each.quiet]),
      };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect(result.quietUnread).toBe(false);
    expect(result.quiet.lastLine).toBe("Quill drafts the copy.");
    expect(result.finishUnread).toBe(true);
    expect(result.finish.lastLine).toBe("The launch page is live.");
    expect(result.stored).toEqual([
      ["m1", false],
      ["m2", true],
      ["m3", false],
    ]);
  });

  // covers UX-006, CH-009, DP-003
  it("[TC-DP-252] a reply you read that is continued in place is unread again once it ends, even after a late read of the cut-off reply", async () => {
    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      yield* repo.insertAgent(
        new Agent({
          id: agentId,
          name: "Aldric",
          roleTitle: "Guide",
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
      yield* repo.upsertThread(new Thread({ id: threadId, agentId, title: "Plan", createdAt: now, updatedAt: now }));
      const unread = () => repo.listUnreadThreads.pipe(Effect.map((listed) => listed.threadIds.includes(threadId)));
      yield* repo.upsertMessage(
        new Message({ ...message("m1"), role: "user", actor: OWNER_ACTOR, configVersion: null }),
      );
      // The reply was cut off, and you read it as it was.
      const half = yield* repo.upsertMessage(new Message({ ...message("m2", "failed"), content: "Half a plan" }));
      yield* repo.markThreadRead(threadId, MessageId.make("m2"), half.value.revision);
      const read = yield* unread();
      // Continue resumes it in the same message, which stays read while it runs.
      yield* repo.upsertMessage(new Message({ ...message("m2", "streaming"), content: "Half a plan, and" }));
      const continuing = yield* unread();
      const whole = yield* repo.upsertMessage(new Message({ ...message("m2"), content: "Half a plan, and the rest." }));
      const continued = yield* unread();
      // Another device's read of the cut-off reply, landing only now, leaves the rest unread.
      const late = yield* repo.markThreadRead(threadId, MessageId.make("m2"), half.value.revision);
      // A fresh read of the list says the same, and reading the rest clears it.
      const listed = (yield* repo.listUnreadThreads).threadIds.includes(threadId);
      const marked = yield* repo.markThreadRead(threadId, MessageId.make("m2"), whole.value.revision);
      return {
        read,
        continuing,
        continued,
        late: Option.isNone(late),
        listed,
        cleared: Option.map(marked, (change) => change.value.readRevision === whole.value.revision),
        after: yield* unread(),
      };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect(result).toEqual({
      read: false,
      continuing: false,
      continued: true,
      late: true,
      listed: true,
      cleared: Option.some(true),
      after: false,
    });
  });

  // covers CH-009, DP-003
  it("[TC-DP-041] stores when a thread was archived and lists live and archived threads apart", async () => {
    const thread = (id: string, archivedAt: string | null) =>
      new Thread({ id: ThreadId.make(id), agentId, title: id, archivedAt, createdAt: now, updatedAt: now });
    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      yield* repo.insertAgent(
        new Agent({
          id: agentId,
          name: "Aldric",
          roleTitle: "Guide",
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
      yield* repo.upsertThread(thread("live", null));
      yield* repo.upsertThread(thread("older", "2026-10-29T00:00:00.000Z"));
      yield* repo.upsertThread(thread("newer", "2026-10-30T00:00:00.000Z"));
      // Restoring is the same write with no archived time.
      yield* repo.upsertThread(thread("restored", "2026-10-31T00:00:00.000Z"));
      yield* repo.upsertThread(thread("restored", null));
      return {
        live: (yield* repo.listThreads(agentId)).map((t) => t.id),
        archived: (yield* repo.listArchivedThreads(agentId)).map((t) => [t.id, t.archivedAt]),
      };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect(result.live).toEqual(["live", "restored"]);
    expect(result.archived).toEqual([
      ["newer", "2026-10-30T00:00:00.000Z"],
      ["older", "2026-10-29T00:00:00.000Z"],
    ]);
  });

  // covers DP-003, AG-001
  it("[TC-DP-002] stores the full look seed range and orders ties the same on every database", async () => {
    const agent = (id: string, lookSeed: number) =>
      new Agent({
        id: AgentId.make(id),
        name: id,
        roleTitle: "Guide",
        runtime: "claude-code",
        model: null,
        effort: null,
        instructions: "",
        lookSeed,
        lookColor: "violet",
        configVersion: 1,
        createdAt: now,
      });
    const thread = (id: string) =>
      new Thread({ id: ThreadId.make(id), agentId, title: id, createdAt: now, updatedAt: now });

    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      // Inserted out of id order, with equal timestamps and ids whose order depends on collation.
      for (const [id, seed] of [
        ["b", 2 ** 32 - 1],
        ["B", 0],
        [agentId, 2 ** 31],
        ["a-c", 7],
        ["ab", 8],
      ] as const) {
        yield* repo.insertAgent(agent(id, seed));
      }
      // A second insert with a taken id changes nothing.
      const reinserted = yield* repo.insertAgent(agent("b", 5));
      for (const id of ["t-b", "T-a", "t-a", "ta"]) yield* repo.upsertThread(thread(id));
      return {
        reinserted,
        agents: yield* repo.listAgents,
        threads: yield* repo.listThreads(agentId),
      };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect(Option.isNone(result.reinserted)).toBe(true);
    // Ties fall back to the id, compared byte by byte (uppercase before lowercase, "-" before letters).
    expect(result.agents.map((a) => [a.id, a.lookSeed])).toEqual([
      ["B", 0],
      ["a-c", 7],
      ["ab", 8],
      ["aldric", 2 ** 31],
      ["b", 2 ** 32 - 1],
    ]);
    expect(result.threads.map((t) => t.id)).toEqual(["T-a", "t-a", "t-b", "ta"]);
  });

  // covers AG-002, DP-003
  it("[TC-AG-021] keeps every configuration version and stores an edit only on top of the current one", async () => {
    const first = new Agent({
      id: agentId,
      name: "Aldric",
      roleTitle: "Guide",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "Be brief.",
      lookSeed: 2 ** 32 - 1,
      lookColor: "violet",
      configVersion: 1,
      createdAt: now,
    });
    const second = new Agent({
      ...first,
      ...roleFields("qa"),
      instructions: "Be thorough.",
      effort: "high",
      configVersion: 2,
    });

    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      yield* repo.insertAgent(first);
      const updated = yield* repo.updateAgentConfig(second);
      // Another edit also based on version 1 arrives after version 2 is stored.
      const stale = yield* repo.updateAgentConfig(new Agent({ ...first, roleTitle: "Writer", configVersion: 2 }));
      return {
        updated,
        stale,
        agent: yield* repo.findAgent(agentId),
        v1: yield* repo.findAgentConfig(agentId, 1),
        v2: yield* repo.findAgentConfig(agentId, 2),
        v3: yield* repo.findAgentConfig(agentId, 3),
      };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect([Option.isSome(result.updated), Option.isSome(result.stale)]).toEqual([true, false]);
    // The stored hob carries the revision of the edit's journal entry.
    expect(Option.getOrThrow(result.agent)).toEqual(new Agent({ ...second, revision: 2 }));
    expect(Option.getOrThrow(result.v1)).toMatchObject({
      version: 1,
      role: null,
      roleTitle: "Guide",
      sigil: "assistant",
      hat: null,
      tool: null,
      instructions: "Be brief.",
      effort: null,
      lookSeed: 2 ** 32 - 1,
    });
    expect(Option.getOrThrow(result.v2)).toMatchObject({
      version: 2,
      role: "qa",
      roleTitle: "QA engineer",
      sigil: "qa",
      hat: "horned",
      tool: "lantern",
      instructions: "Be thorough.",
    });
    expect(Option.isNone(result.v3)).toBe(true);
  });

  // covers ADR 034 (Scope, The Charm), DP-003
  it("[TC-DP-406-02] keeps a hob's Summoning scope and its withheld Charms with each configuration version", async () => {
    const first = new Agent({
      id: agentId,
      name: "Aldric",
      roleTitle: "Guide",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 1,
      lookColor: "moss",
      configVersion: 1,
      createdAt: now,
    });
    const policy = {
      ...first.policy,
      charms: {
        granted: ["github", "summoning"],
        overrides: { "summoning.summon": "ask" as const },
        summoning: { summoned: false, hobs: ["pip"], self: true },
      },
    };
    const second = new Agent({ ...first, policy, configVersion: 2 });
    const third = new Agent({
      ...first,
      policy: { ...first.policy, charms: { granted: ["github"], withheld: ["summoning"] } },
      configVersion: 3,
    });
    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      yield* repo.insertAgent(first);
      yield* repo.updateAgentConfig(second);
      yield* repo.updateAgentConfig(third);
      return {
        v1: yield* repo.findAgentConfig(agentId, 1),
        v2: yield* repo.findAgentConfig(agentId, 2),
        agent: yield* repo.findAgent(agentId),
      };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect(Option.getOrThrow(result.v1).policy.charms).toEqual({ granted: ["github"] });
    expect(Option.getOrThrow(result.v2).policy.charms).toEqual(policy.charms);
    expect(Option.getOrThrow(result.agent).policy.charms).toEqual({ granted: ["github"], withheld: ["summoning"] });
  });

  // covers AG-002, AG-006, DP-003
  it("[TC-AG-405-01] stores who made each version and who summoned the hob, and journals each change with its actor", async () => {
    const chief = AgentId.make("chief");
    const call = { scope: "task:t-hire", key: "hire-1" };
    const byHob: ChangeActor = { _tag: "Hob", hobId: chief, call };
    const proposed: ChangeActor = { _tag: "YouApplyingProposal", hobId: chief, proposalId: "p-1", call };
    const first = new Agent({
      id: agentId,
      name: "Aldric",
      roleTitle: "Guide",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 1,
      lookColor: "violet",
      configVersion: 1,
      summonedBy: chief,
      summonedFor: TaskId.make("t-hire"),
      summonedUnattended: true,
      createdAt: now,
    });

    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const created = yield* repo.insertAgent(first, byHob);
      const renamed = yield* repo.updateAgentConfig(new Agent({ ...first, name: "Bram", configVersion: 2 }), proposed);
      const edited = yield* repo.updateAgentConfig(new Agent({ ...first, name: "Bram", configVersion: 3 }));
      const paused = yield* repo.setAgentStatus(new Agent({ ...first, status: "paused" }), "active", byHob);
      const woken = yield* repo.setAgentStatus(new Agent({ ...first, status: "active" }), "paused");
      const actors = [created, renamed, edited, paused, woken].map((committed) =>
        Option.getOrThrow(committed).entries.map((entry) => entry.payload),
      );
      return {
        actors,
        agent: Option.getOrThrow(yield* repo.findAgent(agentId)),
        versions: yield* Effect.forEach([1, 2, 3], (version) =>
          repo.findAgentConfig(agentId, version).pipe(Effect.map((config) => Option.getOrThrow(config).actor)),
        ),
      };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect(result.versions).toEqual([byHob, proposed, YOU]);
    expect(result.agent).toMatchObject({ summonedBy: chief, summonedFor: "t-hire", summonedUnattended: true });
    expect(result.actors).toMatchObject([
      [{ _tag: "AgentUpserted", actor: byHob }],
      [{ _tag: "AgentUpserted", actor: proposed, agent: { name: "Bram" } }],
      [{ _tag: "AgentUpserted", actor: YOU }],
      [{ _tag: "AgentUpserted", actor: byHob, agent: { status: "paused" } }],
      [{ _tag: "AgentUpserted", actor: YOU, agent: { status: "active" } }],
    ]);
  });

  // covers AG-006, DP-003
  it("[TC-AG-035] stores a hob's lifecycle status and retirement time, refuses a change from a stale status and lists hobs by status", async () => {
    const agent = (id: string, status?: "active" | "paused" | "retired") =>
      new Agent({
        id: AgentId.make(id),
        name: id,
        roleTitle: "Guide",
        runtime: "claude-code",
        model: null,
        effort: null,
        instructions: "",
        lookSeed: 1,
        lookColor: "violet",
        configVersion: 1,
        createdAt: now,
        ...(status ? { status } : {}),
      });

    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      yield* repo.insertAgent(agent("a"));
      yield* repo.insertAgent(agent("b", "paused"));
      yield* repo.insertAgent(agent("c"));
      const retired = yield* repo.setAgentStatus(
        new Agent({ ...agent("c", "retired"), retiredAt: "2026-10-30T12:00:00.000Z" }),
        "active",
      );
      // A wake computed from an earlier read of "paused" must not undo the retirement.
      const staleWake = yield* repo.setAgentStatus(agent("c", "active"), "paused");
      const ids = (statuses: ReadonlyArray<"active" | "paused" | "retired">) =>
        repo.listAgentsWithStatus(statuses).pipe(Effect.map((agents) => agents.map((a) => [a.id, a.status])));
      return {
        retired,
        staleWake,
        current: yield* ids(["active", "paused"]),
        archived: yield* ids(["retired"]),
        retiredAt: (yield* repo.listAgentsWithStatus(["retired"]))[0]?.retiredAt,
        activeRetiredAt: (yield* repo.listAgentsWithStatus(["active"]))[0]?.retiredAt,
        none: yield* ids([]),
      };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect([Option.isSome(result.retired), Option.isSome(result.staleWake)]).toEqual([true, false]);
    expect(result.current).toEqual([
      ["a", "active"],
      ["b", "paused"],
    ]);
    expect(result.archived).toEqual([["c", "retired"]]);
    expect([result.retiredAt, result.activeRetiredAt]).toEqual(["2026-10-30T12:00:00.000Z", null]);
    expect(result.none).toEqual([]);
  });

  // covers AG-006, DP-003
  it("[TC-AG-1246] stores a hob's wait to retire, keeps it through a pause and ends it when the hob retires", async () => {
    const hob = new Agent({
      id: AgentId.make("wren"),
      name: "Wren",
      roleTitle: "Guide",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 1,
      lookColor: "violet",
      configVersion: 1,
      createdAt: now,
    });
    const retiring = { since: "2026-11-08T12:00:00.000Z", by: YOU };
    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      yield* repo.insertAgent(hob);
      const started = yield* repo.setAgentRetiring(hob.id, retiring, YOU);
      const again = yield* repo.setAgentRetiring(hob.id, { ...retiring, since: "2026-11-09T12:00:00.000Z" }, YOU);
      // A pause computed from a read made before the wait began does not undo it.
      const paused = yield* repo.setAgentStatus(new Agent({ ...hob, status: "paused" }), "active");
      const retired = yield* repo.setAgentStatus(
        new Agent({ ...hob, status: "retired", retiredAt: "2026-11-08T13:00:00.000Z" }),
        "paused",
      );
      const afterRetired = yield* repo.setAgentRetiring(hob.id, retiring, YOU);
      return {
        started: Option.map(started, (each) => each.value.retiring),
        again: Option.isSome(again),
        paused: Option.map(paused, (each) => [each.value.status, each.value.retiring]),
        retired: Option.map(retired, (each) => [each.value.status, each.value.retiring]),
        afterRetired: Option.isSome(afterRetired),
        stored: (yield* repo.findAgent(hob.id)).pipe(Option.map((each) => each.retiring)),
      };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect(result.started).toEqual(Option.some(retiring));
    expect(result.again).toBe(false);
    expect(result.paused).toEqual(Option.some(["paused", retiring]));
    expect(result.retired).toEqual(Option.some(["retired", null]));
    expect(result.afterRetired).toBe(false);
    expect(result.stored).toEqual(Option.some(null));
  });

  // covers DP-003, CH-008
  it("[TC-DP-050] keeps queued messages in order, starts one with its reply after the thread's messages and removes only queued ones", async () => {
    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      yield* repo.insertAgent(
        new Agent({
          id: agentId,
          name: "Aldric",
          roleTitle: "Guide",
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
      yield* repo.upsertThread(new Thread({ id: threadId, agentId, title: "Queue", createdAt: now, updatedAt: now }));
      const user = (id: string, status: Message["status"]) =>
        new Message({ ...message(id, status), role: "user", actor: OWNER_ACTOR, configVersion: null });
      yield* repo.upsertMessage(user("q1", "queued"));
      yield* repo.upsertMessage(message("reply", "streaming"));
      yield* repo.upsertMessage(user("q2", "queued"));
      const next = yield* repo.nextQueuedMessage(threadId);
      const threads = yield* repo.threadsWithQueuedMessages;
      const startQ1 = new Message({ ...user("q1", "queued"), status: "complete" });
      const started = yield* repo.startQueuedMessage(startQ1, message("q1-reply", "streaming"));
      const startedTwice = yield* repo.startQueuedMessage(startQ1, message("q1-again", "streaming"));
      const removedStarted = yield* repo.removeQueuedMessage(threadId, MessageId.make("q1"));
      const removedElsewhere = yield* repo.removeQueuedMessage(ThreadId.make("other"), MessageId.make("q2"));
      const removed = yield* repo.removeQueuedMessage(threadId, MessageId.make("q2"));
      return {
        next: Option.map(next, (m) => m.id),
        threads,
        flags: [started, startedTwice]
          .map(Option.isSome)
          .concat([removedStarted, removedElsewhere, removed].map(Option.isSome)),
        messages: (yield* repo.listMessages(threadId)).map((m) => [m.id, m.status]),
        empty: yield* repo.threadsWithQueuedMessages,
      };
    }).pipe(Effect.provide(TestLayer), Effect.runPromise);

    expect(result.next).toEqual(Option.some("q1"));
    expect(result.threads).toEqual([threadId]);
    expect(result.flags).toEqual([true, false, false, false, true]);
    expect(result.messages).toEqual([
      ["reply", "streaming"],
      ["q1", "complete"],
      ["q1-reply", "streaming"],
    ]);
    expect(result.empty).toEqual([]);
  });
});
