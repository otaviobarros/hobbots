import type { SidebarRead } from "@hobbots/api";
import {
  type Actor,
  type BackpackItem,
  type Channel,
  type ChannelId,
  channelsNeedingYou,
  deciderOf,
  hobActor,
  type Sidebar,
  type SidebarChannel,
  sameActor,
  sidebarOf,
  User,
  UserId,
  userIdOf,
} from "@hobbots/domain";
import { Context, Effect, Layer, Option } from "effect";
import { ApprovalRepository } from "./approvals.ts";
import { ChannelMemberRepository } from "./channel-members.ts";
import { ForYouRepository } from "./for-you.ts";
import { HobbotsRepository } from "./repository.ts";
import { TaskRepository } from "./tasks.ts";
import { hubOwner, sessionActor, UserRepository } from "./users.ts";

/**
 * The sidebar (ADR 039, The sidebar; #1469), for the person whose session asks: every open channel
 * of every hob they can talk to, with its members, what they have not read and what waits on them
 * there as its decider (as For you decides it), sorted by the pure `sidebarOf`. Nothing of it is
 * stored. A hub built without members, users or For you's reads, as in some tests, counts each
 * channel as yours and its hob's and leaves every decision to its owner.
 */

/** Blocked work that waits for a person's choice: the Backpack's, which the app provides. */
export class BlockedWork extends Context.Service<
  BlockedWork,
  { readonly list: Effect.Effect<ReadonlyArray<Pick<BackpackItem, "channelId">>> }
>()("@hobbots/agents/BlockedWork") {}

/** Who you are when the hub has no list of users: your session's actor, named after its id. */
export const unlistedUser = (actor: Actor) =>
  new User({
    id: UserId.make(actor.id),
    name: actor.id,
    initials: actor.id.slice(0, 1).toUpperCase(),
    color: "amber",
    state: "active",
  });

const counts = (rows: ReadonlyArray<{ readonly channelId: ChannelId; readonly count: number }>) =>
  new Map(rows.map((row) => [row.channelId, row.count]));

/**
 * The people the sidebar's rows name: every row's other members, and whoever wrote a camp's last
 * line, who may have left it since (#1563).
 */
export const namedPeople = (
  sidebar: Sidebar,
  channels: ReadonlyArray<Pick<Channel, "id" | "lastAuthor">>,
): ReadonlySet<UserId> => {
  const lastAuthors = new Map(channels.map((channel) => [channel.id, channel.lastAuthor]));
  return new Set(
    [
      ...[...sidebar.camps, ...sidebar.directMessages].flatMap((place) => place.others),
      ...sidebar.camps.flatMap((place) => Option.toArray(Option.fromNullishOr(lastAuthors.get(place.channelId)))),
    ].flatMap((actor) => Option.toArray(userIdOf(actor))),
  );
};

export class SidebarList extends Context.Service<SidebarList, { readonly current: Effect.Effect<SidebarRead> }>()(
  "@hobbots/agents/SidebarList",
) {
  static readonly layer = Layer.effect(
    SidebarList,
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const approvals = yield* ApprovalRepository;
      const tasks = yield* TaskRepository;
      const blocked = yield* BlockedWork;
      const members = yield* Effect.serviceOption(ChannelMemberRepository);
      const users = yield* Effect.serviceOption(UserRepository);
      const forYou = yield* Effect.serviceOption(ForYouRepository);
      const membersOf = (channel: Channel, you: Actor): Effect.Effect<SidebarChannel["members"]> =>
        Option.match(members, {
          onNone: () =>
            Effect.succeed<SidebarChannel["members"]>([
              { actor: you, state: "active" as const },
              { actor: hobActor(channel.ownerHobId), state: "active" as const },
            ]),
          onSome: (repository) => repository.list(channel.id),
        });
      // What waits on `you`, channel by channel, where you are the decider.
      const needingYou = (you: Actor) =>
        Effect.gen(function* () {
          const [pending, blockers, questions, failed] = yield* Effect.all([
            approvals.listPending,
            blocked.list,
            tasks.listWaitingQuestions,
            tasks.listFailedTasks,
          ]);
          const owners = yield* Option.match(forYou, {
            onNone: () => Effect.succeed<ReadonlyMap<ChannelId, Actor>>(new Map()),
            onSome: (reads) => reads.owners,
          });
          const decides = (channelId: ChannelId) =>
            sameActor(deciderOf({ requester: null, owner: owners.get(channelId) ?? null, hubOwner }), you);
          return channelsNeedingYou({ approvals: pending, blockers, questions, failed, decides });
        });
      return SidebarList.of({
        current: Effect.gen(function* () {
          const you = yield* sessionActor;
          const hobs = yield* repo.listAgentsWithStatus(["active", "paused"]);
          const channels = (yield* Effect.forEach(hobs, (hob) => repo.listChannels(hob.id))).flat();
          const unread = counts(
            yield* Option.match(members, { onNone: () => Effect.succeed([]), onSome: (m) => m.unreadReplies(you) }),
          );
          const mentions = counts(
            yield* Option.match(members, { onNone: () => Effect.succeed([]), onSome: (m) => m.unreadMentions(you) }),
          );
          const needing = yield* needingYou(you);
          const entries: ReadonlyArray<SidebarChannel> = yield* Effect.forEach(channels, (channel) =>
            Effect.map(membersOf(channel, you), (list) => ({
              channel,
              members: list,
              unread: unread.get(channel.id) ?? 0,
              mentions: mentions.get(channel.id) ?? 0,
              needsYou: needing.has(channel.id),
            })),
          );
          const sidebar = sidebarOf({ you, channels: entries });
          const everyone = yield* Option.match(users, {
            onNone: () => Effect.succeed<ReadonlyArray<User>>([]),
            onSome: (repository) => repository.list,
          });
          const yours = Option.getOrUndefined(userIdOf(you));
          const named = namedPeople(sidebar, channels);
          return {
            you: everyone.find((user) => user.id === yours) ?? unlistedUser(you),
            people: everyone.filter((user) => named.has(user.id)),
            sidebar,
          };
        }).pipe(Effect.withSpan("SidebarList.current")),
      });
    }),
  );
}
