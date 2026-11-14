import {
  type Actor,
  type AgentId,
  type AnswerCause,
  answerersFor,
  brainLabel,
  hobActor,
  MentionRefused,
  type Message,
  OWNER_ACTOR,
  sameActor,
  type Thread,
  type ThreadMember,
  ThreadMembers,
} from "@hobbots/domain";
import { Effect, Option } from "effect";
import { HobbotsRepository } from "./repository.ts";
import { ThreadMemberRepository } from "./thread-members.ts";
import { UserRepository } from "./users.ts";

// Who a hob's turn hears from and why it runs (ADR 039, The context pack with several hobs): every
// speaker named, the thread's members, and the reason for the turn.

/**
 * Why a turn runs, as `answerersFor` decided it: its cause and who caused it, or null when no actor
 * did. The floor's `TurnRequest` (#1461) carries both; until a turn is handed one, the runner works
 * it out from the prompt with `turnReasonOf`.
 */
export interface TurnReason {
  readonly cause: AnswerCause;
  readonly by: Actor | null;
}

/** A member as the pack lists them. */
export interface PackMember {
  readonly name: string;
  readonly kind: "person" | "hob";
  /** The member is the hob whose turn it is. */
  readonly you: boolean;
  /** The member is the thread's owner. */
  readonly owner: boolean;
}

/** What the pack says of the people and hobs in a thread, for one hob's turn. */
export interface PackPeople {
  /** The hob whose turn it is. */
  readonly you: AgentId;
  /** The thread's active members, the owner first, then in the order they joined. */
  readonly members: ReadonlyArray<PackMember>;
  /** A message's author as the transcript names them: "Marina (person)", "Quill (hob)" or "You". */
  readonly speaker: (message: Message) => string;
  /** An actor's name alone, such as "Marina". */
  readonly nameOf: (actor: Actor) => string;
  /** The thread's member rows as stored, in every state, which `turnReasonOf` reads. */
  readonly rows: ReadonlyArray<ThreadMember>;
  /**
   * Whether the thread is shared: more than one hob, or more than one person (ADR 039). Only a
   * shared thread's pack lists who is here: in a direct message it says nothing a hob does not know.
   */
  readonly shared: boolean;
}

/** The name the pack gives a person it has no record of, as briefings named you before people had names. */
export const UNKNOWN_PERSON = "User";

/**
 * A message's author: its actor, or, for a message from before authors were recorded, the owner
 * for yours and the thread's hob for a reply.
 */
export const authorOf = (message: Message, thread: Pick<Thread, "agentId">): Actor =>
  message.actor ?? (message.role === "assistant" ? hobActor(thread.agentId) : OWNER_ACTOR);

/** The hob's own replies: written by it, or by the thread's hob before authors were recorded. */
export const isOwnReply = (message: Message, thread: Pick<Thread, "agentId">, agentId: AgentId): boolean =>
  message.role === "assistant" && sameActor(authorOf(message, thread), hobActor(agentId));

/**
 * The people and hobs of `thread` as `agentId`'s turn names them. Without members stored, the
 * thread's own two: its owner and its hob. Without user records, a person is named "Someone".
 */
export const makePackPeople = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  const memberRepo = yield* Effect.serviceOption(ThreadMemberRepository);
  const users = yield* Effect.serviceOption(UserRepository);
  return (thread: Thread, agentId: AgentId) =>
    Effect.gen(function* () {
      const stored = Option.isNone(memberRepo) ? [] : yield* memberRepo.value.list(thread.id);
      const active = stored.filter(ThreadMembers.isActive).map((member) => member.actor);
      const actors: ReadonlyArray<Actor> = active.length > 0 ? active : [OWNER_ACTOR, hobActor(thread.agentId)];
      const people = Option.isNone(users) ? [] : yield* users.value.list;
      const agents = yield* repo.listAgents;
      const nameOf = (actor: Actor): string => {
        switch (actor.kind) {
          case "user":
            return people.find((user) => user.id === actor.id)?.name ?? UNKNOWN_PERSON;
          case "hob":
            return agents.find((agent) => agent.id === actor.id)?.name ?? actor.id;
          case "hub":
            return "Hobbots";
        }
      };
      const you = hobActor(agentId);
      const speaker = (message: Message): string => {
        const author = authorOf(message, thread);
        if (sameActor(author, you)) {
          return message.runtime === null ? "You" : `You, thinking with ${brainLabel(message.runtime, message.model)}`;
        }
        return `${nameOf(author)} (${author.kind === "user" ? "person" : author.kind})`;
      };
      const members = actors.map(
        (actor): PackMember => ({
          name: nameOf(actor),
          kind: actor.kind === "hob" ? "hob" : "person",
          you: sameActor(actor, you),
          owner: sameActor(actor, OWNER_ACTOR),
        }),
      );
      const shared =
        members.filter((m) => m.kind === "hob").length > 1 || members.filter((m) => m.kind === "person").length > 1;
      return { you: agentId, members, speaker, nameOf, rows: stored, shared } satisfies PackPeople;
    });
});

/**
 * Why `agentId` answers `prompt`, worked out as the floor decides it (ADR 039, Who answers): its
 * own entry in `answerersFor`. Null for a turn no message caused, such as a continuation, or one the
 * rule gives to nobody, as when the thread changed hands.
 */
export const turnReasonOf = (
  prompt: Message | null,
  thread: Thread,
  members: ReadonlyArray<ThreadMember>,
  agentId: AgentId,
): TurnReason | null => {
  if (prompt === null) return null;
  const decided = answerersFor(
    { role: prompt.role, actor: prompt.actor, mentions: prompt.mentions, repliesTo: null },
    { id: thread.id, kind: thread.kind, quest: null },
    members,
  );
  if (decided instanceof MentionRefused) return null;
  const owed = decided.find((each) => each.hobId === agentId);
  return owed === undefined ? null : { cause: owed.cause, by: prompt.actor ?? OWNER_ACTOR };
};

/** The line that says why the turn runs: "Leo mentioned you.", or "You are the only hob here." */
export const reasonLine = (reason: TurnReason, nameOf: (actor: Actor) => string): string => {
  const by = reason.by === null ? null : nameOf(reason.by);
  switch (reason.cause) {
    case "mention":
      return by === null ? "You were mentioned." : `${by} mentioned you.`;
    case "reply":
      return by === null ? "Someone replied to you." : `${by} replied to you.`;
    case "relay":
      return by === null ? "Another hob mentioned you." : `${by}, another hob, mentioned you.`;
    case "only-hob":
      return "You are the only hob here.";
    case "lead":
      return "You lead the quest running here, and nobody else was mentioned.";
  }
};
