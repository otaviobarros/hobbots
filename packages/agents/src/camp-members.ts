import { AgentNotFound, HobUnavailable, ThreadArchived, ThreadNotFound } from "@hobbots/api";
import {
  type Actor,
  AgentId,
  type Committed,
  hobStanding,
  MemberRefused,
  type Thread,
  type ThreadId,
  type ThreadMember,
  ThreadMembers,
  takesNewWork,
} from "@hobbots/domain";
import { Context, Effect, Layer, Option } from "effect";
import { HobAdmission, withThreadLock } from "./admission.ts";
import { ChatService } from "./chat.ts";
import { announcer, announcing, EventPublisher } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";
import { ThreadMemberRepository } from "./thread-members.ts";
import { sessionActor } from "./users.ts";

/**
 * Adding hobs to a camp and taking them out (ADR 039, Members). Every change is a member event of
 * #1453, made by a person already in the camp. Taking a hob out drops what it still owed there in
 * the same transaction, stops the reply it is writing, and hands the floor on.
 */
export class CampMembers extends Context.Service<
  CampMembers,
  {
    /**
     * Adds a hob, or a person the hub knows, to the camp, added by the person asking; one who left or
     * was removed comes back, and one already in is returned as they are. A hob that takes no new
     * work is refused, as are a direct message and someone the hub does not know.
     */
    readonly add: (
      threadId: ThreadId,
      actor: Actor,
    ) => Effect.Effect<ThreadMember, ThreadNotFound | ThreadArchived | AgentNotFound | HobUnavailable | MemberRefused>;
    /**
     * Takes a member out of the camp, by the person asking. A hob's answers still waiting there are
     * dropped with it, and a reply it is writing is stopped. The camp's owner, the hob that leads it
     * and a direct message's two are refused.
     */
    readonly remove: (
      threadId: ThreadId,
      actor: Actor,
    ) => Effect.Effect<ThreadMember, ThreadNotFound | ThreadArchived | MemberRefused>;
  }
>()("@hobbots/agents/CampMembers") {
  static readonly layer = Layer.effect(
    CampMembers,
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const members = yield* ThreadMemberRepository;
      const admission = yield* HobAdmission;
      const chat = yield* ChatService;
      const announce = announcer(yield* Effect.serviceOption(EventPublisher), "a member change");
      const announced = announcing(announce);

      const liveThread = (threadId: ThreadId) =>
        Effect.gen(function* () {
          const found = yield* repo.findThread(threadId);
          if (Option.isNone(found)) return yield* new ThreadNotFound({ threadId });
          const thread = found.value;
          if (thread.archivedAt !== null) return yield* new ThreadArchived({ threadId, archivedAt: thread.archivedAt });
          return thread;
        });

      // Only a person in the thread changes who is in it.
      const requireMember = (thread: Thread, actor: Actor) =>
        Effect.gen(function* () {
          const by = yield* sessionActor;
          const member = yield* members.find(thread.id, by);
          if (Option.isSome(member) && ThreadMembers.isActive(member.value)) return by;
          return yield* new MemberRefused({ threadId: thread.id, actor, reason: "not-member" });
        });

      // A hob joins only while it takes new work, read under its own lock so a pause or retirement
      // cannot land between the check and the write.
      const addHob = (thread: Thread, hobId: AgentId, by: Actor) =>
        admission.withHob(
          hobId,
          Effect.gen(function* () {
            const agent = yield* repo.findAgent(hobId);
            if (Option.isNone(agent)) return yield* new AgentNotFound({ agentId: hobId });
            if (!takesNewWork(agent.value)) {
              return yield* new HobUnavailable({ agentId: hobId, status: hobStanding(agent.value) });
            }
            return yield* announced(members.add(thread.id, { kind: "hob", id: hobId }, by));
          }),
        );

      const add = Effect.fn("CampMembers.add")(function* (threadId: ThreadId, actor: Actor) {
        const thread = yield* liveThread(threadId);
        const by = yield* requireMember(thread, actor);
        if (actor.kind === "hob") return yield* addHob(thread, AgentId.make(actor.id), by);
        return yield* announced(members.add(threadId, actor, by));
      });

      // Under the camp's lock, which every turn there is admitted under: a turn either took its
      // request before the removal, and is stopped here, or finds it dropped and never starts.
      const remove = Effect.fn("CampMembers.remove")(function* (threadId: ThreadId, actor: Actor) {
        const thread = yield* liveThread(threadId);
        const by = yield* requireMember(thread, actor);
        const member = yield* withThreadLock(
          admission,
          thread,
          Effect.gen(function* () {
            const removed = yield* announced(repo.removeMember(threadId, actor, by));
            if (actor.kind === "hob") yield* chat.stop(threadId, AgentId.make(actor.id));
            return removed.member;
          }),
        );
        // The floor goes to whoever waits next.
        yield* chat.wake(threadId);
        return member;
      });

      return CampMembers.of({ add, remove });
    }),
  );
}
