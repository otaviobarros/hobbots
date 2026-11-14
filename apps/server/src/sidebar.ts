import {
  ApprovalRepository,
  HobbotsRepository,
  sessionActor,
  TaskRepository,
  ThreadMemberRepository,
  UserRepository,
} from "@hobbots/agents";
import { HobbotsApi } from "@hobbots/api";
import {
  type Actor,
  hobActor,
  type SidebarThread,
  sidebarOf,
  type Thread,
  type ThreadId,
  threadsNeedingYou,
  User,
  UserId,
  userIdOf,
} from "@hobbots/domain";
import { Backpack } from "@hobbots/inbox";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";

// The sidebar (ADR 039, The sidebar; #1469), for user sessions only (PE-006): the hub reads the open
// threads of every hob you can talk to, hob by hob, with their members and what you have not read,
// and what waits on you there, and sorts them with `sidebarOf`. Nothing of it is stored. A hub built without members or users, as
// in some tests, counts each thread as yours and its hob's.

/** Who you are when the hub has no list of users: your session's actor, named after its id. */
const unnamed = (actor: Actor) =>
  new User({
    id: UserId.make(actor.id),
    name: actor.id,
    initials: actor.id.slice(0, 1).toUpperCase(),
    color: "amber",
    state: "active",
  });

const counts = (rows: ReadonlyArray<{ readonly threadId: ThreadId; readonly count: number }>) =>
  new Map(rows.map((row) => [row.threadId, row.count]));

export const SidebarHandlers = HttpApiBuilder.group(HobbotsApi, "sidebar", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const members = yield* Effect.serviceOption(ThreadMemberRepository);
    const users = yield* Effect.serviceOption(UserRepository);
    const approvals = yield* ApprovalRepository;
    const backpack = yield* Backpack;
    const tasks = yield* TaskRepository;
    const membersOf = (thread: Thread, you: Actor): Effect.Effect<SidebarThread["members"]> =>
      Option.match(members, {
        onNone: () =>
          Effect.succeed<SidebarThread["members"]>([
            { actor: you, state: "active" as const },
            // standards-allow STD-ARCH-021: with no member list, the thread's members are you and the hob it belongs to
            { actor: hobActor(thread.agentId), state: "active" as const },
          ]),
        onSome: (repository) => repository.list(thread.id),
      });
    return handlers.handleAll({
      current: () =>
        Effect.gen(function* () {
          const you = yield* sessionActor;
          const hobs = yield* repo.listAgentsWithStatus(["active", "paused"]);
          const threads = (yield* Effect.forEach(hobs, (hob) => repo.listThreads(hob.id))).flat();
          const unread = counts(
            yield* Option.match(members, { onNone: () => Effect.succeed([]), onSome: (m) => m.unreadReplies(you) }),
          );
          const mentions = counts(
            yield* Option.match(members, { onNone: () => Effect.succeed([]), onSome: (m) => m.unreadMentions(you) }),
          );
          const [pending, blockers, questions, failed] = yield* Effect.all([
            approvals.listPending,
            backpack.listBlocked({ _tag: "Workspace" }),
            tasks.listWaitingQuestions,
            tasks.listFailedTasks,
          ]);
          const needing = threadsNeedingYou({ approvals: pending, blockers, questions, failed });
          const entries: ReadonlyArray<SidebarThread> = yield* Effect.forEach(threads, (thread) =>
            Effect.map(membersOf(thread, you), (list) => ({
              thread,
              members: list,
              unread: unread.get(thread.id) ?? 0,
              mentions: mentions.get(thread.id) ?? 0,
              needsYou: needing.has(thread.id),
            })),
          );
          const sidebar = sidebarOf({ you, threads: entries });
          const everyone = yield* Option.match(users, {
            onNone: () => Effect.succeed<ReadonlyArray<User>>([]),
            onSome: (repository) => repository.list,
          });
          const yours = Option.getOrUndefined(userIdOf(you));
          const named = [...sidebar.camps, ...sidebar.directMessages].flatMap((place) =>
            place.others.flatMap((actor) => Option.toArray(userIdOf(actor))),
          );
          return {
            you: everyone.find((user) => user.id === yours) ?? unnamed(you),
            people: everyone.filter((user) => named.includes(user.id)),
            sidebar,
          };
        }),
    });
  }),
);
