import { ApprovalRepository, ChatService, HobbotsRepository, TaskRepository } from "@hobbots/agents";
import {
  type AgentId,
  type ApprovalRequest,
  type BackpackItem,
  type FailedTask,
  type HobPresence,
  hobPresenceState,
  leadsNeedingYou,
  type ReplyActivity,
  type ChannelId,
} from "@hobbots/domain";
import { Backpack } from "@hobbots/inbox";
import { Context, Effect, HashMap, Layer, Option, PubSub, Ref, Schedule } from "effect";
import { type BusEvent, EventBus } from "./event-bus.ts";

/**
 * The journal entries that can change a hob's presence: its lifecycle, a request, stuck work, a
 * question or a member's failed Task that waits on you (ADR 027).
 */
const CHANGES_PRESENCE: ReadonlySet<string> = new Set([
  "AgentUpserted",
  "ApprovalRequested",
  "ApprovalResolved",
  "BackpackItemRecorded",
  "BackpackItemChanged",
  "QuestionAsked",
  "QuestionAnswered",
  "QuestionEscalated",
  "QuestionWithdrawn",
  "TaskCreated",
  "TaskStateChanged",
  "TaskCompleted",
]);

const changesPresence = (event: BusEvent) =>
  event._tag === "Journaled" ? CHANGES_PRESENCE.has(event.entry.payload._tag) : event.event._tag === "ChannelRunChanged";

/** The chats whose hob a presence needs to know: those something waits on you in. */
const chatsToOwn = ({
  pending,
  blockers,
  failed,
}: {
  readonly pending: ReadonlyArray<Pick<ApprovalRequest, "channelId">>;
  readonly blockers: ReadonlyArray<Pick<BackpackItem, "channelId">>;
  readonly failed: ReadonlyArray<FailedTask>;
}): ReadonlyArray<ChannelId> => {
  const ids = [...pending, ...blockers, ...failed.map(({ task }) => task)].flatMap((each) =>
    each.channelId === null ? [] : [each.channelId],
  );
  return [...new Set(ids)];
};

interface Published {
  readonly revision: number;
  readonly hobs: HashMap.HashMap<AgentId, HobPresence>;
}

type PresenceChange =
  | { readonly _tag: "Changed"; readonly presence: HobPresence }
  | { readonly _tag: "Removed"; readonly agentId: AgentId; readonly revision: number };

/**
 * What was published, brought up to `now`: each hob whose state changed, and each hob that is no
 * longer live, takes the next revision.
 */
const nextPresences = (
  last: Published,
  now: ReadonlyArray<Pick<HobPresence, "agentId" | "state">>,
): readonly [ReadonlyArray<PresenceChange>, Published] => {
  const changes: Array<PresenceChange> = [];
  let revision = last.revision;
  let hobs = HashMap.empty<AgentId, HobPresence>();
  for (const { agentId, state } of now) {
    const before = HashMap.get(last.hobs, agentId);
    if (Option.isSome(before) && before.value.state === state) {
      hobs = HashMap.set(hobs, agentId, before.value);
      continue;
    }
    revision += 1;
    const presence = { agentId, state, revision };
    changes.push({ _tag: "Changed", presence });
    hobs = HashMap.set(hobs, agentId, presence);
  }
  for (const agentId of HashMap.keys(last.hobs)) {
    if (HashMap.has(hobs, agentId)) continue;
    revision += 1;
    changes.push({ _tag: "Removed", agentId, revision });
  }
  return [changes, { revision, hobs }];
};

/**
 * Every hob's presence, decided by the hub and published as `HobPresenceChanged` whenever it changes
 * (ADR 037): its lifecycle first, then whether something waits on you, then what its channels' running
 * replies are doing. Retired hobs have none.
 */
export class HobPresences extends Context.Service<
  HobPresences,
  {
    /**
     * Every live hob's presence as last published, for the sync snapshot, and the revision of the
     * last change to any: a hob left out has no presence as of it.
     */
    readonly current: Effect.Effect<{ readonly revision: number; readonly hobs: ReadonlyArray<HobPresence> }>;
  }
>()("@hobbots/server/HobPresences") {
  static readonly layer = Layer.effect(
    HobPresences,
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const chat = yield* ChatService;
      const repo = yield* HobbotsRepository;
      const approvals = yield* ApprovalRepository;
      const backpack = yield* Backpack;
      const tasks = yield* TaskRepository;
      const published = yield* Ref.make<Published>({ revision: 0, hobs: HashMap.empty() });

      // Every live hob's presence, read now. A chat's hob is read only for the chats that need it.
      const decide = Effect.gen(function* () {
        const hobs = yield* repo.listAgentsWithStatus(["active", "paused"]);
        const [{ runs }, pending, blockers, questions, failed] = yield* Effect.all([
          chat.channelRuns,
          approvals.listPending,
          backpack.listBlocked({ _tag: "Workspace" }),
          tasks.listWaitingQuestions,
          tasks.listFailedTasks,
        ]);
        const chats = chatsToOwn({ pending, blockers, failed });
        const owners = new Map(
          yield* Effect.forEach(chats, (channelId) =>
            Effect.map(repo.findChannel(channelId), (channel) =>
              Option.match(channel, {
                onNone: () => [],
                // What waits in a chat on you asks for the hob the chat belongs to.
                onSome: (owned) => [[channelId, owned.ownerHobId] as const],
              }),
            ),
          ).pipe(Effect.map((pairs) => pairs.flat())),
        );
        const needsYou = leadsNeedingYou({
          approvals: pending,
          blockers,
          questions,
          failed,
          leadOf: (channelId) => owners.get(channelId),
        });
        // A running reply is the hob's that holds the floor, in a camp it joined too (ADR 039): a run
        // with a reply always names its speaker.
        const replies = (agentId: AgentId): ReadonlyArray<ReplyActivity> =>
          runs.flatMap((run) => (run.reply !== null && run.speaking === agentId ? [run.reply] : []));
        return hobs.map((hob) => ({
          agentId: hob.id,
          state: hobPresenceState({ status: hob.status, needsYou: needsYou.has(hob.id), replies: replies(hob.id) }),
        }));
      });

      // Keeps what changed, each at the next revision, and publishes it: a new presence, or the end of
      // a retired hob's.
      const refresh = Effect.gen(function* () {
        const now = yield* decide;
        const changes = yield* Ref.modify(published, (last) => nextPresences(last, now));
        yield* Effect.forEach(
          changes,
          (change) =>
            bus.publishTransient(
              change._tag === "Changed"
                ? { _tag: "HobPresenceChanged", presence: change.presence }
                : { _tag: "HobPresenceRemoved", agentId: change.agentId, revision: change.revision },
            ),
          { discard: true },
        );
      });
      // A read that fails is tried again, waiting longer each time up to 30 seconds, until one
      // succeeds, so a presence never stays stale for want of a later change.
      const refreshed = refresh.pipe(
        Effect.sandbox,
        Effect.tapError((cause) => Effect.logWarning("Could not work out the hobs' presence; trying again", cause)),
        Effect.retry(Schedule.min([Schedule.exponential("100 millis"), Schedule.spaced("30 seconds")])),
      );

      // Subscribed before the first read, so no change after it is missed. Changes that arrive
      // together are read once.
      const subscription = yield* bus.subscribe;
      yield* refreshed.pipe(
        Effect.andThen(
          PubSub.takeAll(subscription).pipe(
            Effect.flatMap((events) => (events.some(changesPresence) ? refreshed : Effect.void)),
            Effect.forever,
          ),
        ),
        Effect.forkScoped,
      );

      return HobPresences.of({
        current: Ref.get(published).pipe(
          Effect.map(({ revision, hobs }) => ({ revision, hobs: Array.from(HashMap.values(hobs)) })),
        ),
      });
    }),
  );
}
