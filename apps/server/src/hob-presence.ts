import { ApprovalRepository, ChatService, HobbotsRepository, TaskRepository } from "@hobbots/agents";
import {
  type AgentId,
  type HobPresence,
  hobPresenceState,
  leadsNeedingYou,
  type ReplyActivity,
  type ThreadId,
} from "@hobbots/domain";
import { Backpack } from "@hobbots/inbox";
import { Context, Effect, HashMap, Layer, Option, PubSub, Ref } from "effect";
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
  event._tag === "Journaled" ? CHANGES_PRESENCE.has(event.entry.payload._tag) : event.event._tag === "ThreadRunChanged";

interface Published {
  readonly revision: number;
  readonly hobs: HashMap.HashMap<AgentId, HobPresence>;
}

/**
 * Every hob's presence, decided by the hub and published as `HobPresenceChanged` whenever it changes
 * (ADR 037): its lifecycle first, then whether something waits on you, then what its threads' running
 * replies are doing. Retired hobs have none.
 */
export class HobPresences extends Context.Service<
  HobPresences,
  {
    /** Every hob's presence as last published, for the sync snapshot. */
    readonly current: Effect.Effect<ReadonlyArray<HobPresence>>;
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
          chat.threadRuns,
          approvals.listPending,
          backpack.listBlocked({ _tag: "Workspace" }),
          tasks.listWaitingQuestions,
          tasks.listFailedTasks,
        ]);
        const chats = new Set<ThreadId>([
          ...runs.map((run) => run.threadId),
          ...pending.flatMap((request) => (request.threadId === null ? [] : [request.threadId])),
          ...blockers.flatMap((item) => (item.threadId === null ? [] : [item.threadId])),
          ...failed.flatMap(({ task }) => (task.threadId === null ? [] : [task.threadId])),
        ]);
        const owners = new Map(
          yield* Effect.forEach(chats, (threadId) =>
            Effect.map(repo.findThread(threadId), (thread) =>
              Option.match(thread, { onNone: () => [], onSome: (found) => [[threadId, found.agentId] as const] }),
            ),
          ).pipe(Effect.map((pairs) => pairs.flat())),
        );
        const needsYou = leadsNeedingYou({
          approvals: pending,
          blockers,
          questions,
          failed,
          leadOf: (threadId) => owners.get(threadId),
        });
        const replies = (agentId: AgentId): ReadonlyArray<ReplyActivity> =>
          runs.flatMap((run) => (run.reply !== null && owners.get(run.threadId) === agentId ? [run.reply] : []));
        return hobs.map((hob) => ({
          agentId: hob.id,
          state: hobPresenceState({ status: hob.status, needsYou: needsYou.has(hob.id), replies: replies(hob.id) }),
        }));
      });

      // Keeps what changed, each at the next revision, drops retired hobs, and publishes the changes.
      const refresh = Effect.gen(function* () {
        const now = yield* decide;
        const changed = yield* Ref.modify(published, ({ revision, hobs }): readonly [Array<HobPresence>, Published] => {
          const changes: Array<HobPresence> = [];
          let next = revision;
          let kept = HashMap.empty<AgentId, HobPresence>();
          for (const { agentId, state } of now) {
            const last = HashMap.get(hobs, agentId);
            if (Option.isSome(last) && last.value.state === state) {
              kept = HashMap.set(kept, agentId, last.value);
            } else {
              next += 1;
              const presence = { agentId, state, revision: next };
              changes.push(presence);
              kept = HashMap.set(kept, agentId, presence);
            }
          }
          return [changes, { revision: next, hobs: kept }];
        });
        yield* Effect.forEach(changed, (presence) => bus.publishTransient({ _tag: "HobPresenceChanged", presence }), {
          discard: true,
        });
      });

      // Subscribed before the first read, so no change after it is missed. Changes that arrive
      // together are read once.
      const subscription = yield* bus.subscribe;
      yield* refresh;
      yield* PubSub.takeAll(subscription).pipe(
        Effect.flatMap((events) => (events.some(changesPresence) ? refresh : Effect.void)),
        Effect.catchCause((cause) => Effect.logWarning("Could not work out the hobs' presence", cause)),
        Effect.forever,
        Effect.forkScoped,
      );

      return HobPresences.of({
        current: Ref.get(published).pipe(Effect.map(({ hobs }) => Array.from(HashMap.values(hobs)))),
      });
    }),
  );
}
