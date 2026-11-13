import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Actor,
  AgentId,
  type AnswerPlace,
  answerersFor,
  type MemberState,
  MentionRefused,
  type RunningQuest,
  type SaidMessage,
  Thread,
  ThreadId,
  ThreadMember,
} from "../src/index.ts";

// Issue #1460 (ADR 039, Who answers): answerersFor decides from the message and the members alone
// which hobs owe a message an answer, in order, and refuses a mention of a hob that is not a member.

const at = "2026-11-13T10:00:00.000Z";
const OWNER: Actor = { kind: "user", id: "owner" };
const HOBS = ["quill", "pip", "rook", "leo", "nell"] as const;
const hob = (id: string): Actor => ({ kind: "hob", id });

const member = (actor: Actor, state: MemberState = "active") =>
  new ThreadMember({
    threadId: ThreadId.make("camp"),
    actor,
    role: actor.kind === "user" ? "owner" : "member",
    state,
    joinedAt: at,
    addedBy: OWNER,
    readRevision: null,
    mutedUntil: null,
    revision: 1,
  });

const hobIds = fc.constantFrom(...HOBS);
const actors: fc.Arbitrary<Actor> = fc.oneof(
  hobIds.map(hob),
  fc.constantFrom<Actor>(OWNER, { kind: "user", id: "marina" }),
);
const authors: fc.Arbitrary<Actor | null> = fc.oneof(
  fc.constant(null),
  actors,
  fc.constant<Actor>({ kind: "hub", id: "hub" }),
);

const said: fc.Arbitrary<SaidMessage> = fc.record({
  role: fc.constantFrom("user", "assistant", "note"),
  actor: authors,
  mentions: fc.array(actors, { maxLength: 5 }),
  repliesTo: fc.option(actors, { nil: null }),
});

/** The owner, then each hob at most once in a random state. */
const memberLists = fc
  .uniqueArray(fc.tuple(hobIds, fc.constantFrom<MemberState>("active", "active", "left", "removed")), {
    selector: ([id]) => id,
    maxLength: HOBS.length,
  })
  .map((hobs) => [member(OWNER), ...hobs.map(([id, state]) => member(hob(id), state))]);

const quests: fc.Arbitrary<RunningQuest | null> = fc.option(
  fc.record({
    leadId: hobIds.map((id) => AgentId.make(id)),
    party: fc.uniqueArray(
      hobIds.map((id) => AgentId.make(id)),
      { maxLength: 3 },
    ),
  }),
  { nil: null },
);
const places: fc.Arbitrary<AnswerPlace> = fc.record({
  id: fc.constant(ThreadId.make("camp")),
  kind: fc.constantFrom("chat", "camp"),
  quest: quests,
});

const cases = fc.record({ message: said, thread: places, members: memberLists });

const activeHobs = (members: ReadonlyArray<ThreadMember>) =>
  members.filter((m) => m.actor.kind === "hob" && m.state === "active").map((m) => m.actor.id);
const hears = (id: string, members: ReadonlyArray<ThreadMember>, quest: RunningQuest | null) =>
  activeHobs(members).includes(id) || quest?.leadId === id || (quest?.party.includes(AgentId.make(id)) ?? false);
const hobMentions = (message: SaidMessage) => [
  ...new Set(message.mentions.filter((a) => a.kind === "hob").map((a) => a.id)),
];
const byHob = (message: SaidMessage) => message.actor?.kind === "hob";
const byPerson = (message: SaidMessage) => message.actor === null || message.actor.kind === "user";

/** Whether the message names anyone who can answer it: a hob it mentions, or one it replies to that hears it. */
const namesSomeone = (message: SaidMessage, members: ReadonlyArray<ThreadMember>, quest: RunningQuest | null) => {
  const author = byHob(message) ? message.actor?.id : undefined;
  const replied = message.repliesTo?.kind === "hob" && hears(message.repliesTo.id, members, quest);
  return [...hobMentions(message), ...(replied && message.repliesTo ? [message.repliesTo.id] : [])].some(
    (id) => id !== author,
  );
};

describe("answerersFor", () => {
  // covers ADR 039 (Who answers, rule 1)
  it("[TC-OR-1460-01] wakes nobody for a note to self, whatever it mentions", () => {
    fc.assert(
      fc.property(cases, ({ message, thread, members }) => {
        expect(answerersFor({ ...message, role: "note" }, thread, members)).toEqual([]);
      }),
    );
  });

  // covers ADR 039 (Who answers, rule 1)
  it("[TC-OR-1460-02] wakes nobody for a hob's message that names no other hob", () => {
    fc.assert(
      fc.property(cases, ({ message, thread, members }) => {
        fc.pre(message.role !== "note" && !byPerson(message) && !namesSomeone(message, members, thread.quest));
        const decided = answerersFor(message, thread, members);
        if (!(decided instanceof MentionRefused)) expect(decided).toEqual([]);
      }),
    );
  });

  // covers ADR 039 (Who answers, rule 2)
  it("[TC-OR-1460-03] refuses a mention of a hob that is not a member, naming each such hob once in order", () => {
    fc.assert(
      fc.property(cases, ({ message, thread, members }) => {
        fc.pre(message.role !== "note");
        const missing = hobMentions(message).filter((id) => !hears(id, members, thread.quest));
        const decided = answerersFor(message, thread, members);
        if (missing.length > 0)
          expect(decided).toEqual(
            new MentionRefused({ threadId: thread.id, hobs: missing.map((id) => AgentId.make(id)) }),
          );
        else expect(Array.isArray(decided)).toBe(true);
      }),
    );
  });

  // covers ADR 039 (Who answers, rules 2 and 3)
  it("[TC-OR-1460-04] wakes the mentioned hobs in order, then the hob replied to, each once and never the author", () => {
    fc.assert(
      fc.property(cases, ({ message, thread, members }) => {
        fc.pre(message.role !== "note" && namesSomeone(message, members, thread.quest));
        const decided = answerersFor(message, thread, members);
        fc.pre(!(decided instanceof MentionRefused));
        if (decided instanceof MentionRefused) return;
        const author = byHob(message) ? message.actor?.id : undefined;
        const replied =
          message.repliesTo?.kind === "hob" && hears(message.repliesTo.id, members, thread.quest)
            ? [message.repliesTo.id]
            : [];
        const expected = [...new Set([...hobMentions(message), ...replied])].filter((id) => id !== author);
        expect(decided.map((a) => a.hobId)).toEqual(expected);
        for (const answerer of decided) {
          const wasMentioned = hobMentions(message).includes(answerer.hobId);
          const cause = byHob(message) ? "relay" : wasMentioned ? "mention" : "reply";
          expect(answerer.cause).toBe(cause);
        }
      }),
    );
  });

  // covers ADR 039 (Who answers, rule 3)
  it("[TC-OR-1460-05] counts a reply to a hob's message as a mention of that hob", () => {
    fc.assert(
      fc.property(cases, hobIds, ({ thread, members }, replied) => {
        fc.pre(hears(replied, members, thread.quest));
        const message: SaidMessage = { role: "user", actor: OWNER, mentions: [], repliesTo: hob(replied) };
        expect(answerersFor(message, thread, members)).toEqual([{ hobId: replied, cause: "reply" }]);
      }),
    );
  });

  // covers ADR 039 (Who answers, rule 4)
  it("[TC-OR-1460-06] with no mention outside a Quest, wakes the only hob, and nobody in a camp with several", () => {
    fc.assert(
      fc.property(cases, ({ message, thread, members }) => {
        const place = { ...thread, quest: null };
        fc.pre(message.role !== "note" && byPerson(message) && !namesSomeone(message, members, null));
        fc.pre(hobMentions(message).every((id) => hears(id, members, null)));
        const hobs = activeHobs(members);
        expect(answerersFor(message, place, members)).toEqual(
          hobs.length === 1 ? [{ hobId: hobs[0], cause: "only-hob" }] : [],
        );
      }),
    );
  });

  // covers ADR 039 (Who answers, rule 5)
  it("[TC-OR-1460-07] in a running Quest's thread, a message with no mention reaches its lead and a mention its party", () => {
    fc.assert(
      fc.property(cases, ({ message, thread, members }) => {
        fc.pre(thread.quest !== null && message.role !== "note" && byPerson(message));
        const quest = thread.quest as RunningQuest;
        if (hobMentions(message).length === 0 && !namesSomeone(message, members, quest)) {
          expect(answerersFor(message, thread, members)).toEqual([{ hobId: quest.leadId, cause: "lead" }]);
        }
        const party = [quest.leadId, ...quest.party];
        const decided = answerersFor({ ...message, mentions: party.map(hob), repliesTo: null }, thread, members);
        expect(decided).toEqual([...new Set(party)].map((hobId) => ({ hobId, cause: "mention" })));
      }),
    );
  });

  // covers ADR 039 (Who answers: no mention wakes every hob)
  it("[TC-OR-1460-08] wakes only hobs that hear the message, never more than were named, plus one", () => {
    fc.assert(
      fc.property(cases, ({ message, thread, members }) => {
        const decided = answerersFor(message, thread, members);
        if (decided instanceof MentionRefused) return;
        const ids = decided.map((a) => a.hobId);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.length).toBeLessThanOrEqual(hobMentions(message).length + 1);
        for (const id of ids) expect(hears(id, members, thread.quest)).toBe(true);
      }),
    );
  });

  // covers ADR 039 (Who answers rule 4: there is no answer-rule setting)
  it("[TC-OR-1460-09] keeps no answer-rule or host setting on a thread", () => {
    const fields = Object.keys(Thread.fields);
    expect(fields.filter((field) => /answer|host/i.test(field))).toEqual([]);
  });
});
