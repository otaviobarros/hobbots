import { ChannelNotFound } from "@hobbots/api";
import { type CatchUp, type CatchUpQuest, catchUpOf, deciderOf, sameActor, type ChannelId } from "@hobbots/domain";
import { Context, Effect, Layer, Option } from "effect";
import { RecordRepository } from "./records.ts";
import { HobbotsRepository } from "./repository.ts";
import { ChannelMemberRepository } from "./channel-members.ts";
import { hubOwner, sessionActor } from "./users.ts";

/**
 * Catch-up (ADR 037): what changed in a chat or camp since you last read it, worked out on the hub
 * from your read marker and the channel's records by the pure `catchUpOf`, so every device shows the
 * same. Read it before the chat marks itself read, since reading moves the marker past it.
 */

/** What catch-up reads besides the transcript and the records. */
export class CatchUpRepository extends Context.Service<
  CatchUpRepository,
  {
    /** The newest message revision you read the channel through, or null when you never read it. */
    readonly marker: (channelId: ChannelId) => Effect.Effect<number | null>;
    /** The Quests followed in the channel, with their summaries and goals. */
    readonly quests: (channelId: ChannelId) => Effect.Effect<ReadonlyArray<CatchUpQuest>>;
  }
>()("@hobbots/agents/CatchUpRepository") {}

export class CatchUps extends Context.Service<
  CatchUps,
  { readonly of: (channelId: ChannelId) => Effect.Effect<CatchUp, ChannelNotFound> }
>()("@hobbots/agents/CatchUps") {
  static readonly layer = Layer.effect(
    CatchUps,
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const reads = yield* CatchUpRepository;
      // A hub without records, as in some tests, catches up on replies and Quests alone.
      const records = yield* Effect.serviceOption(RecordRepository);
      // A hub without members, as in some tests, has its owner decide every channel.
      const members = yield* Effect.serviceOption(ChannelMemberRepository);
      return CatchUps.of({
        of: Effect.fn("CatchUps.of")(function* (channelId: ChannelId) {
          if (Option.isNone(yield* repo.findChannel(channelId))) return yield* new ChannelNotFound({ channelId });
          const you = yield* sessionActor;
          const owner = Option.isNone(members)
            ? undefined
            : (yield* members.value.list(channelId)).find((member) => member.role === "owner")?.actor;
          return catchUpOf({
            you,
            decides: sameActor(deciderOf({ requester: null, owner: owner ?? null, hubOwner }), you),
            marker: yield* reads.marker(channelId),
            messages: yield* repo.listMessages(channelId),
            decisions: Option.isNone(records) ? [] : yield* records.value.listDecisions(channelId),
            artifacts: Option.isNone(records) ? [] : yield* records.value.listArtifacts(channelId),
            quests: yield* reads.quests(channelId),
          });
        }),
      });
    }),
  );
}
