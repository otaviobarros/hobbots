import type { Actor, Committed, MemberRefused, ThreadId, ThreadMember } from "@hobbots/domain";
import { Context, type Effect, type Option } from "effect";

/**
 * Who is in each direct message and camp (ADR 039, Members). A thread is stored with its first two
 * members, the person who made it and its hob, and a hob leaves every thread when it retires and
 * comes back when it returns; this reads them and adds more.
 */
export class ThreadMemberRepository extends Context.Service<
  ThreadMemberRepository,
  {
    /** The thread's members in every state: the owner first, then in the order they joined. */
    readonly list: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<ThreadMember>>;
    readonly find: (threadId: ThreadId, actor: Actor) => Effect.Effect<Option.Option<ThreadMember>>;
    /**
     * Adds `actor` to the thread as an active member, added by `addedBy`, journaled as
     * `ThreadMemberAdded`; one who left or was removed comes back, journaled as `ThreadMemberChanged`.
     * Nothing is journaled for a member already active. A direct message takes no one but its person
     * and its hob: `MemberRefused`. Dies when the thread does not exist.
     */
    readonly add: (
      threadId: ThreadId,
      actor: Actor,
      addedBy: Actor,
    ) => Effect.Effect<Committed<ThreadMember>, MemberRefused>;
  }
>()("@hobbots/agents/ThreadMemberRepository") {}
