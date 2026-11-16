import type { HobbotsRepository } from "@hobbots/agents";
import { ChannelNotFound } from "@hobbots/api";
import type { ChannelId } from "@hobbots/domain";
import { Effect, Option } from "effect";

/** Runs `then` for a channel the hub has, and answers ChannelNotFound for one it does not. */
export const forExistingChannel = <A, E, R>(
  repo: HobbotsRepository["Service"],
  channelId: ChannelId,
  then: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ChannelNotFound, R> =>
  repo
    .findChannel(channelId)
    .pipe(
      Effect.flatMap(
        (channel): Effect.Effect<A, E | ChannelNotFound, R> =>
          Option.isNone(channel) ? Effect.fail(new ChannelNotFound({ channelId })) : then,
      ),
    );
