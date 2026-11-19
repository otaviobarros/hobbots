import type { AgentId, ChannelId, PackReport, RuntimeKind } from "@hobbots/domain";
import { Context, Effect, HashMap, Layer, type Option, Ref } from "effect";

/**
 * A hob's session in a channel: a channel keeps one per hob and runtime, which a turn on that
 * runtime resumes, so switching runtimes and back resumes the first session (ADR 037).
 */
export interface PackSession {
  readonly hobId: AgentId;
  readonly runtime: RuntimeKind;
}

/**
 * The report of the last pack each channel's turn read, for the Focus chip and the dev-only endpoint,
 * and of the pack each hob's session there started from, which a Quest it starts lists as "Read
 * first" (ADR 039). Kept in memory: after a restart, a channel's next new session reports again.
 */
export class PackReports extends Context.Service<
  PackReports,
  {
    readonly record: (channelId: ChannelId, session: PackSession, report: PackReport) => Effect.Effect<void>;
    readonly last: (channelId: ChannelId) => Effect.Effect<Option.Option<PackReport>>;
    /** The report of the pack the hob's session on that runtime started from in the channel. */
    readonly lastOf: (channelId: ChannelId, session: PackSession) => Effect.Effect<Option.Option<PackReport>>;
  }
>()("@hobbots/agents/PackReports") {
  static readonly layer = Layer.effect(
    PackReports,
    Effect.gen(function* () {
      // standards-allow STD-ARCH-013: the last report per channel and per session there, a log for review, not lifecycle state.
      const reports = yield* Ref.make(HashMap.empty<ChannelId, PackReport>());
      const sessions = yield* Ref.make(HashMap.empty<string, PackReport>());
      const key = (channelId: ChannelId, session: PackSession) =>
        `${channelId}\u0000${session.hobId}\u0000${session.runtime}`;
      return PackReports.of({
        record: (channelId, session, report) =>
          Effect.andThen(
            Ref.update(reports, HashMap.set(channelId, report)),
            Ref.update(sessions, HashMap.set(key(channelId, session), report)),
          ),
        last: (channelId) => Ref.get(reports).pipe(Effect.map(HashMap.get(channelId))),
        lastOf: (channelId, session) => Ref.get(sessions).pipe(Effect.map(HashMap.get(key(channelId, session)))),
      });
    }),
  );
}
