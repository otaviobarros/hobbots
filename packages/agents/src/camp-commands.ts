import { AgentNotFound, StartFreshRefused, ChannelKeyReused } from "@hobbots/api";
import {
  type Agent,
  type AgentId,
  type ChapterId,
  DEFAULT_CHANNEL_TITLE,
  StartedFresh,
  Channel,
  type ChannelId,
  ChannelLifecycle,
} from "@hobbots/domain";
import { Data, DateTime, Effect, Option, Schedule } from "effect";
import { type ChapterMoveTarget, HobbotsRepository } from "./repository.ts";
import { archiveBlockersOf, type ChannelCommandsDeps } from "./channel-commands.ts";

// Make a camp and Start fresh (ADR 037, #1376). Each is a command: it reads under the hob's lock,
// runs the channel's lifecycle where one changes, and commits the channels, what moves and the journal
// in one transaction before it announces anything. Its key becomes the new channel's id, so the same
// request sent again changes nothing.

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/** What you ask for when you make a camp. */
export interface CampRequest {
  /** The command's key, which becomes the camp's id. */
  readonly key: ChannelId;
  readonly title: string;
  readonly goal: string | null;
  readonly private: boolean;
  /**
   * The other hobs it is made with (ADR 039, Members), in the order picked; the hob it is made for
   * leads its quests. Each must take new work.
   */
  readonly hobs?: ReadonlyArray<AgentId>;
}

/** What the camp commands take from ChatService: its guards and locks, and the writes it announces. */
export interface CampCommandsDeps extends Pick<ChannelCommandsDeps, "requireActive" | "withChannelHob" | "announce"> {
  /** Reads the hob under its lock, so its status does not change before `body` ends. */
  readonly withHob: <A, E, R>(
    agentId: AgentId,
    body: (agent: Agent) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | AgentNotFound, R>;
}

/** Where you move a chapter: into an open camp of the hob's, or into a new camp made with it. */
export type MoveRequest =
  | { readonly _tag: "camp"; readonly campId: ChannelId }
  | ({ readonly _tag: "new" } & CampRequest);

// The other hobs a camp is made with, each once, without the hob it is made for.
const othersOf = (lead: AgentId, hobs: ReadonlyArray<AgentId> = []) =>
  [...new Set(hobs)].filter((hobId) => hobId !== lead);

// The chat changed between its read and the write, as a turn that recorded its session would; read again.
class StaleChat extends Data.TaggedError("StaleChat") {}

export const makeCampCommands = (deps: CampCommandsDeps) =>
  Effect.gen(function* () {
    const { requireActive, withHob, withChannelHob, announce } = deps;
    const repo = yield* HobbotsRepository;
    const archiveBlockers = yield* archiveBlockersOf;

    // Another hob a camp is made with: one the hub knows that takes new work. A retirement that
    // lands before the camp is stored leaves it a member that left.
    const requireJoins = (hobId: AgentId) =>
      Effect.gen(function* () {
        const agent = yield* repo.findAgent(hobId);
        if (Option.isNone(agent)) return yield* new AgentNotFound({ agentId: hobId });
        yield* requireActive(agent.value);
      });

    const makeCamp = Effect.fn("ChatService.makeCamp")(function* (agentId: AgentId, request: CampRequest) {
      return yield* withHob(agentId, (agent) =>
        Effect.gen(function* () {
          // The same camp asked for again is answered as it is, whatever the hob does now.
          const stored = yield* repo.findChannel(request.key);
          const hobs = othersOf(agentId, request.hobs);
          if (Option.isNone(stored)) {
            yield* requireActive(agent);
            yield* Effect.forEach(hobs, requireJoins, { discard: true });
          }
          const now = yield* nowIso;
          const camp = new Channel({
            id: request.key,
            agentId,
            title: request.title,
            kind: "camp",
            goal: request.goal,
            private: request.private,
            createdAt: now,
            updatedAt: now,
          });
          return yield* repo.makeCamp(camp, hobs).pipe(Effect.flatMap(announce));
        }),
      );
    });

    // The same Start fresh sent again: the new chat under its key came from this chat.
    const startedBefore = (channelId: ChannelId, key: ChannelId) =>
      Effect.gen(function* () {
        const stored = yield* repo.findChannel(key);
        if (Option.isNone(stored)) return Option.none<StartedFresh>();
        if (stored.value.origin?.channelId !== channelId || stored.value.kind !== "direct") {
          return yield* new ChannelKeyReused({ channelId: key });
        }
        const superseded = yield* repo.findChannel(channelId).pipe(Effect.map(Option.getOrThrow));
        const carried = yield* repo.listCarriedOver(key);
        return Option.some(new StartedFresh({ superseded, chat: stored.value, carried }));
      });

    const supersede = (channel: Channel, agent: Agent, key: ChannelId) =>
      Effect.gen(function* () {
        if (!ChannelLifecycle.isOpenChat(channel)) {
          return yield* new StartFreshRefused({ channelId: channel.id, reason: "not-open-chat" });
        }
        const at = yield* nowIso;
        const superseded = ChannelLifecycle.transition(channel, {
          _tag: "Supersede",
          at,
          ...(yield* archiveBlockers(channel, agent)),
        });
        if (!(superseded instanceof Channel)) {
          // Its state allows it, so a refusal always names what stopped it.
          return yield* new StartFreshRefused({ channelId: channel.id, reason: superseded.refusal ?? "not-open-chat" });
        }
        const chat = new Channel({
          id: key,
          // standards-allow STD-ARCH-021: the new chat belongs to the same hob
          agentId: channel.agentId,
          title: DEFAULT_CHANNEL_TITLE,
          kind: "direct",
          origin: { channelId: channel.id, chapterId: null },
          createdAt: at,
          updatedAt: at,
        });
        const committed = yield* repo.startFresh({ superseded, chat });
        if (Option.isNone(committed)) return yield* new StaleChat();
        return yield* announce(committed.value);
      });

    const startFresh = Effect.fn("ChatService.startFresh")(function* (channelId: ChannelId, key: ChannelId) {
      return yield* withChannelHob(channelId, (channel, agent) =>
        Effect.gen(function* () {
          const before = yield* startedBefore(channelId, key);
          if (Option.isSome(before)) return before.value;
          // Read again on each try: a turn may record its session on the chat between the read and the write.
          return yield* repo.findChannel(channelId).pipe(
            Effect.map(Option.getOrElse(() => channel)),
            Effect.flatMap((latest) => supersede(latest, agent, key)),
            Effect.retry({ while: (error) => error._tag === "StaleChat", schedule: Schedule.recurs(3) }),
            Effect.catchTag("StaleChat", () =>
              Effect.die(new Error(`Chat ${channelId} kept changing while it was started fresh`)),
            ),
          );
        }),
      );
    });

    // A new camp comes from the channel and chapter it is made from (ADR 037).
    const targetOf = (channel: Channel, agent: Agent, chapterId: ChapterId, request: MoveRequest) =>
      Effect.gen(function* () {
        if (request._tag === "camp") return { _tag: "camp", campId: request.campId } satisfies ChapterMoveTarget;
        // The same camp asked for again is answered as it is, whatever the hob does now.
        // standards-allow STD-ARCH-021: a camp made from a chapter is led by the hob the chapter belongs to
        const hobs = othersOf(channel.agentId, request.hobs);
        if (Option.isNone(yield* repo.findChannel(request.key))) {
          yield* requireActive(agent);
          yield* Effect.forEach(hobs, requireJoins, { discard: true });
        }
        const now = yield* nowIso;
        const camp = new Channel({
          id: request.key,
          // standards-allow STD-ARCH-021: a camp made from a chapter belongs to the same hob
          agentId: channel.agentId,
          title: request.title,
          kind: "camp",
          goal: request.goal,
          private: request.private,
          origin: { channelId: channel.id, chapterId },
          createdAt: now,
          updatedAt: now,
        });
        return { _tag: "new", camp, hobs } satisfies ChapterMoveTarget;
      });

    const moveChapter = Effect.fn("ChatService.moveChapter")(function* (
      channelId: ChannelId,
      chapterId: ChapterId,
      request: MoveRequest,
    ) {
      return yield* withChannelHob(channelId, (channel, agent) =>
        Effect.gen(function* () {
          const target = yield* targetOf(channel, agent, chapterId, request);
          const at = yield* nowIso;
          return yield* repo.moveChapter({ channelId, chapterId, target, at }).pipe(Effect.flatMap(announce));
        }),
      );
    });

    return { makeCamp, startFresh, moveChapter } as const;
  });
