import { type AgentNotFound, StartFreshRefused, ThreadKeyReused } from "@hobbots/api";
import {
  type Agent,
  type AgentId,
  type ChapterId,
  DEFAULT_THREAD_TITLE,
  StartedFresh,
  Thread,
  type ThreadId,
  ThreadLifecycle,
} from "@hobbots/domain";
import { Data, DateTime, Effect, Option, Schedule } from "effect";
import { type ChapterMoveTarget, HobbotsRepository } from "./repository.ts";
import { archiveBlockersOf, type ThreadCommandsDeps } from "./thread-commands.ts";

// Make a camp and Start fresh (ADR 037, #1376). Each is a command: it reads under the hob's lock,
// runs the thread's lifecycle where one changes, and commits the threads, what moves and the journal
// in one transaction before it announces anything. Its key becomes the new thread's id, so the same
// request sent again changes nothing.

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/** What you ask for when you make a camp. */
export interface CampRequest {
  /** The command's key, which becomes the camp's id. */
  readonly key: ThreadId;
  readonly title: string;
  readonly goal: string | null;
  readonly private: boolean;
}

/** What the camp commands take from ChatService: its guards and locks, and the writes it announces. */
export interface CampCommandsDeps extends Pick<ThreadCommandsDeps, "requireActive" | "withThreadHob" | "announce"> {
  /** Reads the hob under its lock, so its status does not change before `body` ends. */
  readonly withHob: <A, E, R>(
    agentId: AgentId,
    body: (agent: Agent) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | AgentNotFound, R>;
}

/** Where you move a chapter: into an open camp of the hob's, or into a new camp made with it. */
export type MoveRequest =
  | { readonly _tag: "camp"; readonly campId: ThreadId }
  | ({ readonly _tag: "new" } & CampRequest);

// The chat changed between its read and the write, as a turn that recorded its session would; read again.
class StaleChat extends Data.TaggedError("StaleChat") {}

export const makeCampCommands = (deps: CampCommandsDeps) =>
  Effect.gen(function* () {
    const { requireActive, withHob, withThreadHob, announce } = deps;
    const repo = yield* HobbotsRepository;
    const archiveBlockers = yield* archiveBlockersOf;

    const makeCamp = Effect.fn("ChatService.makeCamp")(function* (agentId: AgentId, request: CampRequest) {
      return yield* withHob(agentId, (agent) =>
        Effect.gen(function* () {
          // The same camp asked for again is answered as it is, whatever the hob does now.
          const stored = yield* repo.findThread(request.key);
          if (Option.isNone(stored)) yield* requireActive(agent);
          const now = yield* nowIso;
          const camp = new Thread({
            id: request.key,
            agentId,
            title: request.title,
            kind: "camp",
            goal: request.goal,
            private: request.private,
            createdAt: now,
            updatedAt: now,
          });
          return yield* repo.makeCamp(camp).pipe(Effect.flatMap(announce));
        }),
      );
    });

    // The same Start fresh sent again: the new chat under its key came from this chat.
    const startedBefore = (threadId: ThreadId, key: ThreadId) =>
      Effect.gen(function* () {
        const stored = yield* repo.findThread(key);
        if (Option.isNone(stored)) return Option.none<StartedFresh>();
        if (stored.value.origin?.threadId !== threadId || stored.value.kind !== "chat") {
          return yield* new ThreadKeyReused({ threadId: key });
        }
        const superseded = yield* repo.findThread(threadId).pipe(Effect.map(Option.getOrThrow));
        const carried = yield* repo.listCarriedOver(key);
        return Option.some(new StartedFresh({ superseded, chat: stored.value, carried }));
      });

    const supersede = (thread: Thread, agent: Agent, key: ThreadId) =>
      Effect.gen(function* () {
        if (!ThreadLifecycle.isOpenChat(thread)) {
          return yield* new StartFreshRefused({ threadId: thread.id, reason: "not-open-chat" });
        }
        const at = yield* nowIso;
        const superseded = ThreadLifecycle.transition(thread, {
          _tag: "Supersede",
          at,
          ...(yield* archiveBlockers(thread, agent)),
        });
        if (!(superseded instanceof Thread)) {
          // Its state allows it, so a refusal always names what stopped it.
          return yield* new StartFreshRefused({ threadId: thread.id, reason: superseded.refusal ?? "not-open-chat" });
        }
        const chat = new Thread({
          id: key,
          agentId: thread.agentId,
          title: DEFAULT_THREAD_TITLE,
          kind: "chat",
          origin: { threadId: thread.id, chapterId: null },
          createdAt: at,
          updatedAt: at,
        });
        const committed = yield* repo.startFresh({ superseded, chat });
        if (Option.isNone(committed)) return yield* new StaleChat();
        return yield* announce(committed.value);
      });

    const startFresh = Effect.fn("ChatService.startFresh")(function* (threadId: ThreadId, key: ThreadId) {
      return yield* withThreadHob(threadId, (thread, agent) =>
        Effect.gen(function* () {
          const before = yield* startedBefore(threadId, key);
          if (Option.isSome(before)) return before.value;
          // Read again on each try: a turn may record its session on the chat between the read and the write.
          return yield* repo.findThread(threadId).pipe(
            Effect.map(Option.getOrElse(() => thread)),
            Effect.flatMap((latest) => supersede(latest, agent, key)),
            Effect.retry({ while: (error) => error._tag === "StaleChat", schedule: Schedule.recurs(3) }),
            Effect.catchTag("StaleChat", () =>
              Effect.die(new Error(`Chat ${threadId} kept changing while it was started fresh`)),
            ),
          );
        }),
      );
    });

    // A new camp comes from the thread and chapter it is made from (ADR 037).
    const targetOf = (thread: Thread, agent: Agent, chapterId: ChapterId, request: MoveRequest) =>
      Effect.gen(function* () {
        if (request._tag === "camp") return { _tag: "camp", campId: request.campId } satisfies ChapterMoveTarget;
        // The same camp asked for again is answered as it is, whatever the hob does now.
        if (Option.isNone(yield* repo.findThread(request.key))) yield* requireActive(agent);
        const now = yield* nowIso;
        const camp = new Thread({
          id: request.key,
          agentId: thread.agentId,
          title: request.title,
          kind: "camp",
          goal: request.goal,
          private: request.private,
          origin: { threadId: thread.id, chapterId },
          createdAt: now,
          updatedAt: now,
        });
        return { _tag: "new", camp } satisfies ChapterMoveTarget;
      });

    const moveChapter = Effect.fn("ChatService.moveChapter")(function* (
      threadId: ThreadId,
      chapterId: ChapterId,
      request: MoveRequest,
    ) {
      return yield* withThreadHob(threadId, (thread, agent) =>
        Effect.gen(function* () {
          const target = yield* targetOf(thread, agent, chapterId, request);
          const at = yield* nowIso;
          return yield* repo.moveChapter({ threadId, chapterId, target, at }).pipe(Effect.flatMap(announce));
        }),
      );
    });

    return { makeCamp, startFresh, moveChapter } as const;
  });
