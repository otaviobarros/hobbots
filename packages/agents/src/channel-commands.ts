import {
  type HobUnavailable,
  type ChannelArchived,
  ChannelArchiveRefused,
  ChannelNotCamp,
  type ChannelNotFound,
} from "@hobbots/api";
import {
  type Agent,
  type ArchiveBlockers,
  type Brain,
  type IllegalChannelTransition,
  isInProgress,
  type MessageId,
  mainLine,
  sameBrain,
  Channel,
  type ChannelId,
  ChannelLifecycle,
  type ChannelLifecycleEvent,
} from "@hobbots/domain";
import { DateTime, Effect, Option } from "effect";
import { ApprovalService } from "./approvals.ts";
import { checkRuntimeBrain } from "./hobs.ts";
import { HobbotsRepository } from "./repository.ts";
import { runtimeAdapters } from "./runtime.ts";
import type { TurnRunnerDeps } from "./turn-runner.ts";

// What you change on a channel besides its turns (#1397): its brain, whether it is archived, its
// title, its pin and how far you read it. Each runs on the channel as stored, under its hob's lock
// where an archive could land between the check and the change.

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const sameOwnBrain = (a: Brain | null, b: Brain | null) => (a === null || b === null ? a === b : sameBrain(a, b));

/** What the channel commands take from ChatService: its guards, and the writes it announces. */
export interface ChannelCommandsDeps extends Pick<TurnRunnerDeps, "changeChannel" | "announce"> {
  readonly findChannel: (channelId: ChannelId) => Effect.Effect<Channel, ChannelNotFound>;
  readonly requireActive: (agent: Agent) => Effect.Effect<void, HobUnavailable>;
  readonly requireLive: (channel: Channel) => Effect.Effect<void, ChannelArchived>;
  /** Reads the channel and its hob again under the hob's lock, so neither changes before `body` ends. */
  readonly withChannelHob: <A, E, R>(
    channelId: ChannelId,
    body: (channel: Channel, agent: Agent) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ChannelNotFound, R>;
  /** Starts what waits in each idle channel. */
  readonly drainChannels: (channelIds: ReadonlyArray<ChannelId>) => Effect.Effect<unknown>;
}

/**
 * What stops a channel from being archived or superseded now, which `ChannelLifecycle` weighs. Run it
 * under the hob's lock, so no turn starts and no message is sent while the channel changes.
 */
export const archiveBlockersOf = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  // Without approvals, no request waits in a channel, so none stops its archive.
  const approvals = yield* Effect.serviceOption(ApprovalService);
  return (channel: Channel, agent: Agent) =>
    Effect.gen(function* () {
      const requests = Option.isSome(approvals) ? yield* approvals.value.listForChannel(channel.id) : [];
      // A turn whose reply has ended no longer stops it, even before its channel is freed.
      const messages = yield* repo.listMessages(channel.id);
      // An answer a hob still owes there, as one a paused member will give, counts as a reply to come.
      const owed = yield* repo.openTurnRequests(mainLine(channel.id));
      return {
        hobRetired: agent.status === "retired",
        approvalPending: requests.some((request) => request.state === "pending"),
        replyRunning: owed.length > 0 || messages.some((m) => m.status === "queued" || isInProgress(m.status)),
      } satisfies ArchiveBlockers;
    });
});

export const makeChannelCommands = (deps: ChannelCommandsDeps) =>
  Effect.gen(function* () {
    const { findChannel, requireActive, requireLive, withChannelHob, changeChannel, announce, drainChannels } = deps;
    const repo = yield* HobbotsRepository;
    const adapters = yield* runtimeAdapters;

    const checkBrainSwitch = Effect.fn("ChatService.checkBrainSwitch")(function* (channelId: ChannelId) {
      const channel = yield* findChannel(channelId);
      // standards-allow STD-ARCH-021: a channel's brain follows the hob it belongs to
      const agent = yield* repo.findAgent(channel.agentId).pipe(Effect.map(Option.getOrThrow));
      if (agent.status === "retired") yield* requireActive(agent);
      yield* requireLive(channel);
    });

    const followHob = Effect.fn("ChatService.followHob")(function* (channelId: ChannelId) {
      const channel = yield* findChannel(channelId);
      const updatedAt = yield* nowIso;
      const changed = yield* changeChannel(channelId, (latest) =>
        latest.brain === null ? null : new Channel({ ...latest, brain: null, updatedAt }),
      );
      return Option.getOrElse(changed, () => channel);
    });

    const setBrain = Effect.fn("ChatService.setBrain")(function* (channelId: ChannelId, brain: Brain | null) {
      return yield* withChannelHob(channelId, (channel, agent) =>
        Effect.gen(function* () {
          if (agent.status === "retired") yield* requireActive(agent);
          yield* requireLive(channel);
          if (brain !== null) {
            const invalid = yield* checkRuntimeBrain(adapters, brain);
            if (invalid !== undefined) return yield* invalid;
          }
          const hob = { runtime: agent.runtime, model: agent.model, effort: agent.effort };
          const own = brain !== null && sameBrain(brain, hob) ? null : brain;
          const updatedAt = yield* nowIso;
          const changed = yield* changeChannel(channelId, (latest) =>
            sameOwnBrain(latest.brain, own) ? null : new Channel({ ...latest, brain: own, updatedAt }),
          );
          return Option.getOrElse(changed, () => channel);
        }),
      );
    });

    const archiveBlockers = yield* archiveBlockersOf;

    // Runs the channel's lifecycle on the channel as stored, so a session a turn records meanwhile is
    // kept, and saves what it changes. A refusal fails as `ChannelArchiveRefused`; one with no reason
    // is a bug, as callers check the state first.
    const changeLifecycle = (channel: Channel, event: ChannelLifecycleEvent) =>
      Effect.gen(function* () {
        let refused: IllegalChannelTransition | undefined;
        const changed = yield* changeChannel(channel.id, (latest) => {
          const next = ChannelLifecycle.transition(latest, event);
          if (next instanceof Channel) return next;
          refused = next;
          return null;
        });
        if (refused === undefined) return Option.getOrElse(changed, () => channel);
        if (refused.refusal === null) return yield* Effect.die(refused);
        return yield* new ChannelArchiveRefused({ channelId: channel.id, reason: refused.refusal });
      });

    const archive = Effect.fn("ChatService.archive")(function* (channelId: ChannelId) {
      return yield* withChannelHob(channelId, (channel, agent) =>
        Effect.gen(function* () {
          if (ChannelLifecycle.isArchived(channel)) return channel;
          const blockers = yield* archiveBlockers(channel, agent);
          return yield* changeLifecycle(channel, { _tag: "Archive", at: yield* nowIso, ...blockers });
        }),
      );
    });

    const restore = Effect.fn("ChatService.restore")(function* (channelId: ChannelId) {
      return yield* withChannelHob(
        channelId,
        (channel, agent) =>
          Effect.gen(function* () {
            if (!ChannelLifecycle.isArchived(channel)) return channel;
            // standards-allow STD-ARCH-021: a restored channel goes back among its owner's channels
            const others = yield* repo.listChannels(channel.agentId);
            return yield* changeLifecycle(channel, {
              _tag: "Restore",
              hobRetired: agent.status === "retired",
              chatOpen: others.some((other) => other.id !== channel.id && ChannelLifecycle.isOpenChat(other)),
            });
          }),
        // Work that arrived while it was archived starts once it is back.
      ).pipe(Effect.tap(() => drainChannels([channelId])));
    });

    // Neither changes `updatedAt`, so a renamed or pinned chat keeps its place by last activity. Both
    // run under the hob's lock, so no archive lands between the check and the change.
    const changeLive = (channelId: ChannelId, change: (channel: Channel) => Channel | null) =>
      withChannelHob(channelId, (channel) =>
        Effect.gen(function* () {
          yield* requireLive(channel);
          return Option.getOrElse(yield* changeChannel(channelId, change), () => channel);
        }),
      );

    const rename = Effect.fn("ChatService.rename")(function* (channelId: ChannelId, title: string) {
      return yield* changeLive(channelId, (latest) =>
        latest.title === title ? null : new Channel({ ...latest, title }),
      );
    });

    const setPinned = Effect.fn("ChatService.setPinned")(function* (channelId: ChannelId, pinned: boolean) {
      const now = yield* nowIso;
      return yield* changeLive(channelId, (latest) =>
        (latest.pinnedAt !== null) === pinned ? null : new Channel({ ...latest, pinnedAt: pinned ? now : null }),
      );
    });

    // A camp's privacy is a setting, like its pin: capture follows it along the journal (ADR 037).
    const setPrivate = Effect.fn("ChatService.setPrivate")(function* (channelId: ChannelId, value: boolean) {
      const channel = yield* findChannel(channelId);
      if (channel.kind !== "camp") return yield* new ChannelNotCamp({ channelId });
      return yield* changeLive(channelId, (latest) =>
        latest.private === value ? null : new Channel({ ...latest, private: value }),
      );
    });

    // Needs no hob lock: the reader's marker moves forward in one statement, whatever else changes
    // the channel.
    const markRead = Effect.fn("ChatService.markRead")(function* (
      channelId: ChannelId,
      messageId: MessageId,
      revision: number,
    ) {
      yield* findChannel(channelId);
      const marked = yield* repo.markChannelRead(channelId, messageId, revision);
      return Option.isSome(marked) ? yield* announce(marked.value) : null;
    });

    return {
      checkBrainSwitch,
      followHob,
      setBrain,
      archive,
      restore,
      rename,
      setPinned,
      setPrivate,
      markRead,
    } as const;
  });
