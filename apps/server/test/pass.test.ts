import {
  HobbotsRepository,
  PASS_ONLY_HOB,
  PASS_TAKEN,
  PASS_UNREADABLE,
  type PromptRequest,
  ThreadMemberRepository,
} from "@hobbots/agents";
import { hobActor, liveSession, type Message, OWNER_ACTOR, PASS_TOOL, type RuntimeKind, Thread } from "@hobbots/domain";
import { waitUntil } from "@hobbots/domain/testing";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it } from "vitest";
import { FRODO, hub, messagesWhen, PIP, partyHub, send, threadId } from "./party-hub.ts";

// Issue #1462 (ADR 039, One hob speaks at a time): a hob asked to answer that has nothing to add
// calls `pass` with a reason. Its turn ends with no message, its request ends `passed`, and the floor
// moves on as after a reply. `pass` is a hub tool, so Claude Code and Codex serve it alike; the fake
// runtime plays each hob from `fake:hub` lines.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const offered = (request: PromptRequest | undefined) => request?.hubTools?.tools.map((tool) => tool.name) ?? [];

/** A party hub whose hobs all think with `runtime`, Frodo's thread made a camp that Pip joined. */
const campOn = async (runtime: RuntimeKind, options: Parameters<typeof partyHub>[0] = {}) => {
  const party = partyHub({ lead: runtime, members: runtime, ...options });
  dispose = party.dispose;
  const { run } = party;
  await run(
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const thread = Option.getOrThrow(yield* repo.findThread(threadId));
      yield* repo.upsertThread(new Thread({ ...thread, kind: "camp" }));
      yield* ThreadMemberRepository.use((members) => members.add(threadId, hobActor(PIP), OWNER_ACTOR));
    }),
  );
  /** Every request in the camp as stored, oldest first. */
  const requests = () =>
    run(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{
          readonly hobId: string;
          readonly state: string;
          readonly passReason: string | null;
        }>`SELECT hob_id, state, pass_reason FROM turn_requests WHERE thread_id = ${threadId}
          ORDER BY queued_at, position`.pipe(Effect.orDie),
      ),
    );
  return { ...party, requests };
};

const replies = (all: ReadonlyArray<Message>) =>
  all.filter((m) => m.role === "assistant").map((m) => [m.actor?.id, m.status]);

describe("pass", () => {
  // covers ADR 039 (One hob speaks at a time), RT-001
  it.each<RuntimeKind>(["claude-code", "codex"])(
    "[TC-CH-1462-01] on %s, a hob that passes leaves no message, and the next hob asked answers",
    async (runtime) => {
      const { run, requests, answers, reactions } = await campOn(runtime);
      // Pip, asked first, has nothing to add; Frodo answers after it.
      reactions.push({ on: "plant", lines: [hub(PASS_TOOL, { key: "pass", reason: "Frodo knows the garden" })] });
      await run(send(["@Pip @Frodo what should we plant?"]));
      // The fake echoes its prompt, so Frodo's answer mentions Pip and wakes it (#1463): the hobs
      // relay to each other until the relay budget leaves the next relay paused for you.
      const stored = await run(
        waitUntil(
          Effect.promise(requests),
          (rows) =>
            rows.some((row) => row.state === "paused") &&
            rows.every((row) => row.state !== "waiting" && row.state !== "speaking"),
          { what: "every request ended", within: "20 seconds" },
        ),
      );
      const all = await run(messagesWhen(() => true));

      expect(answers.get("pass")).toBe(PASS_TAKEN);
      // Pip's pass left no message: the first reply is Frodo's.
      expect(replies(all)[0]).toEqual([FRODO, "complete"]);
      expect(stored.slice(0, 2)).toEqual([
        { hobId: PIP, state: "passed", passReason: "Frodo knows the garden" },
        { hobId: FRODO, state: "answered", passReason: null },
      ]);
    },
    30_000,
  );

  // covers ADR 039 (One hob speaks at a time)
  it("[TC-CH-1462-02] every chat turn is offered pass, and a turn only it was asked for, or with no reason, is refused", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run, requests, answers } = party;
    await run(send(["Plant tomatoes?", hub(PASS_TOOL, { key: "alone", reason: "Nothing to add" })]));
    await run(send(["And beans?", hub(PASS_TOOL, { key: "blank", reason: "  " })]));
    const all = await run(messagesWhen((messages) => messages.filter((m) => m.role === "assistant").length >= 2));

    expect(offered(requests[0])).toContain(PASS_TOOL);
    // Frodo is the only hob here: nobody else would answer, so it answers.
    expect(answers.get("alone")).toBe(PASS_ONLY_HOB);
    expect(answers.get("blank")).toBe(PASS_UNREADABLE);
    expect(replies(all)).toEqual([
      [FRODO, "complete"],
      [FRODO, "complete"],
    ]);
  }, 30_000);

  // covers ADR 039 (One hob speaks at a time), ADR 024, RT-001
  it("[TC-CH-1462-03] on codex, a session that started without pass is not resumed, so the next turn holds it", async () => {
    let first = true;
    const party = partyHub({
      lead: "codex",
      withholds: () => {
        if (!first) return [];
        first = false;
        return [PASS_TOOL];
      },
    });
    dispose = party.dispose;
    const { run, requests } = party;
    await run(send(["My cat is called Miso."]));
    await run(messagesWhen((messages) => messages.length >= 2));
    await run(send(["What is my cat called?"]));
    await run(messagesWhen((messages) => messages.length >= 4));
    const thread = await run(
      HobbotsRepository.use((repo) => repo.findThread(threadId)).pipe(Effect.map(Option.getOrThrow)),
    );

    expect(offered(requests[0])).not.toContain(PASS_TOOL);
    // Codex keeps a thread's first tools, so the second turn starts a new thread that holds pass.
    expect(requests[1]?.sessionId).toBeNull();
    expect(offered(requests[1])).toContain(PASS_TOOL);
    expect(liveSession(thread, "codex", FRODO)?.taskTools).toContain(PASS_TOOL);
  }, 30_000);
});
