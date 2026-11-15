import { AgentNotFound, ChannelArchived, ChannelNotFound, HobUnavailable } from "@hobbots/api";
import {
  type Actor,
  AgentId,
  type Channel,
  type ChannelId,
  type ChannelMember,
  ChannelMembers,
  hobStanding,
  MemberRefused,
  takesNewWork,
  UserId,
} from "@hobbots/domain";
import { Context, Effect, Layer, Option } from "effect";
import { HobAdmission, withChannelLock } from "./admission.ts";
import { ChannelMemberRepository } from "./channel-members.ts";
import { ChatService } from "./chat.ts";
import { announcer, announcing, EventPublisher } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";
import { sessionActor, UserRepository } from "./users.ts";

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
      channelId: ChannelId,
      actor: Actor,
    ) => Effect.Effect<
      ChannelMember,
      ChannelNotFound | ChannelArchived | AgentNotFound | HobUnavailable | MemberRefused
    >;
    /**
     * Takes a member out of the camp, by the person asking. A hob's answers still waiting there are
     * dropped with it, and a reply it is writing is stopped. The camp's owner, the hob that leads it
     * and a direct message's two are refused.
     */
    readonly remove: (
      channelId: ChannelId,
      actor: Actor,
    ) => Effect.Effect<ChannelMember, ChannelNotFound | ChannelArchived | MemberRefused>;
  }
>()("@hobbots/agents/CampMembers") {
  static readonly layer = Layer.effect(
    CampMembers,
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const members = yield* ChannelMemberRepository;
      const users = yield* UserRepository;
      const admission = yield* HobAdmission;
      const chat = yield* ChatService;
      const announce = announcer(yield* Effect.serviceOption(EventPublisher), "a member change");
      const announced = announcing(announce);

      const liveChannel = (channelId: ChannelId) =>
        Effect.gen(function* () {
          const found = yield* repo.findChannel(channelId);
          if (Option.isNone(found)) return yield* new ChannelNotFound({ channelId });
          const channel = found.value;
          if (channel.archivedAt !== null)
            return yield* new ChannelArchived({ channelId, archivedAt: channel.archivedAt });
          return channel;
        });

      // Only a person in the channel changes who is in it.
      const requireMember = (channel: Channel, actor: Actor) =>
        Effect.gen(function* () {
          const by = yield* sessionActor;
          const member = yield* members.find(channel.id, by);
          if (Option.isSome(member) && ChannelMembers.isActive(member.value)) return by;
          return yield* new MemberRefused({ channelId: channel.id, actor, reason: "not-member" });
        });

      // A hob joins only while it takes new work, read under its own lock so a pause or retirement
      // cannot land between the check and the write.
      const addHob = (channel: Channel, hobId: AgentId, by: Actor) =>
        admission.withHob(
          hobId,
          Effect.gen(function* () {
            const agent = yield* repo.findAgent(hobId);
            if (Option.isNone(agent)) return yield* new AgentNotFound({ agentId: hobId });
            if (!takesNewWork(agent.value)) {
              return yield* new HobUnavailable({ agentId: hobId, status: hobStanding(agent.value) });
            }
            return yield* announced(members.add(channel.id, { kind: "hob", id: hobId }, by, true));
          }),
        );

      const add = Effect.fn("CampMembers.add")(function* (channelId: ChannelId, actor: Actor) {
        const channel = yield* liveChannel(channelId);
        const by = yield* requireMember(channel, actor);
        if (actor.kind === "hob") return yield* addHob(channel, AgentId.make(actor.id), by);
        // Only a person the hub knows joins.
        const known = actor.kind === "user" && Option.isSome(yield* users.find(UserId.make(actor.id)));
        if (!known) return yield* new MemberRefused({ channelId, actor, reason: "unknown" });
        return yield* announced(members.add(channelId, actor, by, true));
      });

      // Under the camp's lock, which every turn there is admitted under: a turn either took its
      // request before the removal, and is stopped here, or finds it dropped and never starts.
      const remove = Effect.fn("CampMembers.remove")(function* (channelId: ChannelId, actor: Actor) {
        const channel = yield* liveChannel(channelId);
        const by = yield* requireMember(channel, actor);
        const member = yield* withChannelLock(
          admission,
          channel,
          Effect.gen(function* () {
            const removed = yield* announced(repo.removeMember(channelId, actor, by));
            if (actor.kind === "hob") yield* chat.stop(channelId, AgentId.make(actor.id));
            return removed.member;
          }),
        );
        // The floor goes to whoever waits next.
        yield* chat.wake(channelId);
        return member;
      });

      return CampMembers.of({ add, remove });
    }),
  );
}
