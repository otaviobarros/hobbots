import type { AgentId, ChannelId, PackReport } from "@hobbots/domain";
import { Context, Effect, HashMap, Layer, type Option, Ref } from "effect";

/**
 * The report of the last pack each channel's turn read, for the Focus chip and the dev-only endpoint,
 * and of the last pack each hob's session read there, which a Quest it starts lists as "Read first"
 * (ADR 039). Kept in memory: after a restart, a channel's next new session reports again.
 */
export class PackReports extends Context.Service<
  PackReports,
  {
    readonly record: (channelId: ChannelId, hobId: AgentId, report: PackReport) => Effect.Effect<void>;
    readonly last: (channelId: ChannelId) => Effect.Effect<Option.Option<PackReport>>;
    /** The report of the last pack the hob's session read in the channel. */
    readonly lastOf: (channelId: ChannelId, hobId: AgentId) => Effect.Effect<Option.Option<PackReport>>;
  }
>()("@hobbots/agents/PackReports") {
  static readonly layer = Layer.effect(
    PackReports,
    Effect.gen(function* () {
      // standards-allow STD-ARCH-013: the last report per channel and per hob there, a log for review, not lifecycle state.
      const reports = yield* Ref.make(HashMap.empty<ChannelId, PackReport>());
      const hobs = yield* Ref.make(HashMap.empty<string, PackReport>());
      const key = (channelId: ChannelId, hobId: AgentId) => `${channelId}\u0000${hobId}`;
      return PackReports.of({
        record: (channelId, hobId, report) =>
          Effect.andThen(
            Ref.update(reports, HashMap.set(channelId, report)),
            Ref.update(hobs, HashMap.set(key(channelId, hobId), report)),
          ),
        last: (channelId) => Ref.get(reports).pipe(Effect.map(HashMap.get(channelId))),
        lastOf: (channelId, hobId) => Ref.get(hobs).pipe(Effect.map(HashMap.get(key(channelId, hobId)))),
      });
    }),
  );
}
