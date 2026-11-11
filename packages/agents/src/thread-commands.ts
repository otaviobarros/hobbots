import { type HobUnavailable, type ThreadArchived, ThreadArchiveRefused, type ThreadNotFound } from "@hobbots/api";
import {
  type Agent,
  type Brain,
  type IllegalThreadTransition,
  isInProgress,
  type MessageId,
  sameBrain,
  Thread,
  type ThreadId,
  ThreadLifecycle,
  type ThreadLifecycleEvent,
} from "@hobbots/domain";
import { DateTime, Effect, Option } from "effect";
import { ApprovalService } from "./approvals.ts";
import { checkRuntimeBrain } from "./hobs.ts";
import { HobbotsRepository } from "./repository.ts";
import { runtimeAdapters } from "./runtime.ts";
import type { TurnRunnerDeps } from "./turn-runner.ts";

// What you change on a thread besides its turns (#1397): its brain, whether it is archived, its
// title, its pin and how far you read it. Each runs on the thread as stored, under its hob's lock
// where an archive could land between the check and the change.

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const sameOwnBrain = (a: Brain | null, b: Brain | null) => (a === null || b === null ? a === b : sameBrain(a, b));

/** What the thread commands take from ChatService: its guards, and the writes it announces. */
export interface ThreadCommandsDeps extends Pick<TurnRunnerDeps, "changeThread" | "announce"> {
  readonly findThread: (threadId: ThreadId) => Effect.Effect<Thread, ThreadNotFound>;
  readonly requireActive: (agent: Agent) => Effect.Effect<void, HobUnavailable>;
  readonly requireLive: (thread: Thread) => Effect.Effect<void, ThreadArchived>;
  /** Reads the thread and its hob again under the hob's lock, so neither changes before `body` ends. */
  readonly withThreadHob: <A, E, R>(
    threadId: ThreadId,
    body: (thread: Thread, agent: Agent) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ThreadNotFound, R>;
  /** Starts what waits in each idle thread. */
  readonly drainThreads: (threadIds: ReadonlyArray<ThreadId>) => Effect.Effect<unknown>;
}

export const makeThreadCommands = (deps: ThreadCommandsDeps) =>
  Effect.gen(function* () {
    const { findThread, requireActive, requireLive, withThreadHob, changeThread, announce, drainThreads } = deps;
    const repo = yield* HobbotsRepository;
    const adapters = yield* runtimeAdapters;
    // Without approvals, no request waits in a thread, so none stops its archive.
    const approvals = yield* Effect.serviceOption(ApprovalService);

    const checkBrainSwitch = Effect.fn("ChatService.checkBrainSwitch")(function* (threadId: ThreadId) {
      const thread = yield* findThread(threadId);
      const agent = yield* repo.findAgent(thread.agentId).pipe(Effect.map(Option.getOrThrow));
      if (agent.status === "retired") yield* requireActive(agent);
      yield* requireLive(thread);
    });

    const followHob = Effect.fn("ChatService.followHob")(function* (threadId: ThreadId) {
      const thread = yield* findThread(threadId);
      const updatedAt = yield* nowIso;
      const changed = yield* changeThread(threadId, (latest) =>
        latest.brain === null ? null : new Thread({ ...latest, brain: null, updatedAt }),
      );
      return Option.getOrElse(changed, () => thread);
    });

    const setBrain = Effect.fn("ChatService.setBrain")(function* (threadId: ThreadId, brain: Brain | null) {
      return yield* withThreadHob(threadId, (thread, agent) =>
        Effect.gen(function* () {
          if (agent.status === "retired") yield* requireActive(agent);
          yield* requireLive(thread);
          if (brain !== null) {
            const invalid = yield* checkRuntimeBrain(adapters, brain);
            if (invalid !== undefined) return yield* invalid;
          }
          const hob = { runtime: agent.runtime, model: agent.model, effort: agent.effort };
          const own = brain !== null && sameBrain(brain, hob) ? null : brain;
          const updatedAt = yield* nowIso;
          const changed = yield* changeThread(threadId, (latest) =>
            sameOwnBrain(latest.brain, own) ? null : new Thread({ ...latest, brain: own, updatedAt }),
          );
          return Option.getOrElse(changed, () => thread);
        }),
      );
    });

    // What stops the thread from being archived now, which `ThreadLifecycle` weighs. Runs under the
    // hob's lock, so no turn starts and no message is sent while the thread is being archived.
    const archiveBlockers = (thread: Thread, agent: Agent) =>
      Effect.gen(function* () {
        const requests = Option.isSome(approvals) ? yield* approvals.value.listForThread(thread.id) : [];
        // A turn whose reply has ended no longer stops it, even before its thread is freed.
        const messages = yield* repo.listMessages(thread.id);
        return {
          hobRetired: agent.status === "retired",
          approvalPending: requests.some((request) => request.state === "pending"),
          replyRunning: messages.some((m) => m.status === "queued" || isInProgress(m.status)),
        };
      });

    // Runs the thread's lifecycle on the thread as stored, so a session a turn records meanwhile is
    // kept, and saves what it changes. A refusal fails as `ThreadArchiveRefused`; one with no reason
    // is a bug, as callers check the state first.
    const changeLifecycle = (thread: Thread, event: ThreadLifecycleEvent) =>
      Effect.gen(function* () {
        let refused: IllegalThreadTransition | undefined;
        const changed = yield* changeThread(thread.id, (latest) => {
          const next = ThreadLifecycle.transition(latest, event);
          if (next instanceof Thread) return next;
          refused = next;
          return null;
        });
        if (refused === undefined) return Option.getOrElse(changed, () => thread);
        if (refused.refusal === null) return yield* Effect.die(refused);
        return yield* new ThreadArchiveRefused({ threadId: thread.id, reason: refused.refusal });
      });

    const archive = Effect.fn("ChatService.archive")(function* (threadId: ThreadId) {
      return yield* withThreadHob(threadId, (thread, agent) =>
        Effect.gen(function* () {
          if (ThreadLifecycle.isArchived(thread)) return thread;
          const blockers = yield* archiveBlockers(thread, agent);
          return yield* changeLifecycle(thread, { _tag: "Archive", at: yield* nowIso, ...blockers });
        }),
      );
    });

    const restore = Effect.fn("ChatService.restore")(function* (threadId: ThreadId) {
      return yield* withThreadHob(
        threadId,
        (thread, agent) =>
          Effect.gen(function* () {
            if (!ThreadLifecycle.isArchived(thread)) return thread;
            const others = yield* repo.listThreads(thread.agentId);
            return yield* changeLifecycle(thread, {
              _tag: "Restore",
              hobRetired: agent.status === "retired",
              chatOpen: others.some((other) => other.id !== thread.id && ThreadLifecycle.isOpenChat(other)),
            });
          }),
        // Work that arrived while it was archived starts once it is back.
      ).pipe(Effect.tap(() => drainThreads([threadId])));
    });

    // Neither changes `updatedAt`, so a renamed or pinned chat keeps its place by last activity. Both
    // run under the hob's lock, so no archive lands between the check and the change.
    const changeLive = (threadId: ThreadId, change: (thread: Thread) => Thread | null) =>
      withThreadHob(threadId, (thread) =>
        Effect.gen(function* () {
          yield* requireLive(thread);
          return Option.getOrElse(yield* changeThread(threadId, change), () => thread);
        }),
      );

    const rename = Effect.fn("ChatService.rename")(function* (threadId: ThreadId, title: string) {
      return yield* changeLive(threadId, (latest) =>
        latest.title === title ? null : new Thread({ ...latest, title }),
      );
    });

    const setPinned = Effect.fn("ChatService.setPinned")(function* (threadId: ThreadId, pinned: boolean) {
      const now = yield* nowIso;
      return yield* changeLive(threadId, (latest) =>
        (latest.pinnedAt !== null) === pinned ? null : new Thread({ ...latest, pinnedAt: pinned ? now : null }),
      );
    });

    // Needs no hob lock: the marker moves forward in one statement, whatever else changes the thread.
    const markRead = Effect.fn("ChatService.markRead")(function* (
      threadId: ThreadId,
      messageId: MessageId,
      revision: number,
    ) {
      const thread = yield* findThread(threadId);
      const marked = yield* repo.markThreadRead(threadId, messageId, revision);
      return Option.isSome(marked) ? yield* announce(marked.value) : thread;
    });

    return { checkBrainSwitch, followHob, setBrain, archive, restore, rename, setPinned, markRead } as const;
  });
