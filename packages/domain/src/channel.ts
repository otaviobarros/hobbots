import { Effect, Schema } from "effect";
import { Actor } from "./actor.ts";
import type { RuntimeKind } from "./agent.ts";
import { Brain, RuntimeSession } from "./brain.ts";
import { AgentId, ChapterId, ChannelId } from "./ids.ts";
import { defineMachine } from "./machine.ts";
import { Revision } from "./revision.ts";
import { SkillTrial } from "./skills.ts";

/** What a channel is (ADR 037): a hob's one open `chat`, or a `camp` with a goal of its own. */
export const ChannelKind = Schema.Literals(["direct", "camp"]);
export type ChannelKind = typeof ChannelKind.Type;

/** Where a channel stands (ADR 037), held by `ChannelLifecycleMachine`. */
export const ChannelState = Schema.Literals(["open", "archived", "superseded"]);
export type ChannelState = typeof ChannelState.Type;

/** The channel, and the chapter in it, a camp came from. */
export const ChannelOrigin = Schema.Struct({ channelId: ChannelId, chapterId: Schema.NullOr(ChapterId) });
export type ChannelOrigin = typeof ChannelOrigin.Type;

export class Channel extends Schema.Class<Channel>("Channel")({
  id: ChannelId,
  ownerHobId: AgentId,
  title: Schema.String,
  /**
   * A chat or a camp (ADR 037). A hob has at most one open chat, which the database holds; every
   * other channel is a camp. Channels made before kinds count as camps.
   */
  kind: ChannelKind.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("camp" as const)),
    Schema.withConstructorDefault(Effect.succeed("camp" as const)),
  ),
  /** A camp's goal, or null for a chat and for a camp that names none. */
  goal: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** A private camp's entries are never captured into memory; it still reads the memory brief. */
  private: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
  /** The channel and chapter a camp came from, or null. */
  origin: Schema.NullOr(ChannelOrigin).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** Where the channel stands; only `ChannelLifecycleMachine` changes it, and code outside reads it through `ChannelLifecycle`. */
  state: ChannelState.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("open" as const)),
    Schema.withConstructorDefault(Effect.succeed("open" as const)),
  ),
  /**
   * One session per hob and runtime the channel has used, kept separate from the channel's identity
   * (ADR 017, ADR 039), each in the chapter it started in (ADR 037): read the one a turn resumes
   * with `liveSession`.
   * Channel events journaled before this carry none; their Claude Code session moved here in migration 0020.
   */
  sessions: Schema.Array(RuntimeSession).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
  /**
   * The channel's live chapter (ADR 037), which new messages join and whose sessions a turn resumes.
   * Worked out when the channel is read, never stored; null only on a channel not stored yet, since
   * storing a new channel starts its first chapter.
   */
  liveChapterId: Schema.NullOr(ChapterId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * How many chapters were merged into the live chapter (ADR 037), worked out when the channel is read.
   * Such a merge makes an earlier chapter live again with a new session: `liveSession` resumes only
   * a session that started after the last one.
   */
  liveChapterMerges: Schema.Number.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0)),
    Schema.withConstructorDefault(Effect.succeed(0)),
  ),
  /** The channel's own brain, or null to think with the hob's. A channel setting: it grants nothing. */
  brain: Schema.NullOr(Brain).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * When the channel was archived or superseded, or null while it is open: a fact kept beside
   * `state`. Such a channel is left out of channel lists, takes no new messages, and is still found by
   * search. An archived one takes them again once it is restored; a superseded chat never does.
   */
  archivedAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * The last message the transcript shows, as one line of at most `PREVIEW_LENGTH` characters, for
   * lists of chats. Worked out when the channel is read, never stored; null while it has none.
   */
  lastLine: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * Who wrote `lastLine` (ADR 039, The sidebar): the actor stored with that message, read in the same
   * query as the line, never stored on the channel; null while it has no last line. A shared camp's
   * row names them before the line.
   */
  lastAuthor: Schema.NullOr(Actor).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * When the channel was pinned to the top of its hob's chats, or null when it is not pinned. A
   * channel setting: it grants nothing.
   */
  pinnedAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * The draft this chat tries (ADR 029, Try in a chat), or null for an ordinary chat. Set when the chat
   * is made and never changed: its turns load that draft and no other skill.
   */
  skillTrial: Schema.NullOr(SkillTrial).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  revision: Revision,
}) {}

/**
 * Why a channel cannot be archived or restored now. `reply-running`: a reply is running or a
 * message waits in its queue. `approval-pending`: a tool call waits for the user's decision, which
 * wins when both apply. `hob-retired`: a retired hob's channels stay as they are, which wins over both.
 */
export const ChannelArchiveRefusal = Schema.Literals(["reply-running", "approval-pending", "hob-retired"]);
export type ChannelArchiveRefusal = typeof ChannelArchiveRefusal.Type;

/** What stops a channel from being archived, read under its hob's lock. */
export interface ArchiveBlockers {
  readonly hobRetired: boolean;
  readonly approvalPending: boolean;
  readonly replyRunning: boolean;
}

/** What can happen to a channel's lifecycle. */
export type ChannelLifecycleEvent =
  | ({ readonly _tag: "Archive"; readonly at: string } & ArchiveBlockers)
  | {
      readonly _tag: "Restore";
      readonly hobRetired: boolean;
      /** Whether the hob has another open chat, as when a new chat opened while this one was archived. */
      readonly chatOpen: boolean;
    }
  /** Start fresh: what stops an archive stops it too, as the chat's open work moves in the same step. */
  | ({ readonly _tag: "Supersede"; readonly at: string } & ArchiveBlockers);

/** A change to a channel's lifecycle its state does not allow, with why when something stops it. */
export class IllegalChannelTransition extends Schema.TaggedError<IllegalChannelTransition>()("IllegalChannelTransition", {
  channelId: ChannelId,
  from: ChannelState,
  to: ChannelState,
  refusal: Schema.NullOr(ChannelArchiveRefusal),
}) {}

/** The refusal that wins among an archive's blockers, or null when none stops it. */
const archiveRefusal = (blockers: ArchiveBlockers): ChannelArchiveRefusal | null => {
  if (blockers.hobRetired) return "hob-retired";
  if (blockers.approvalPending) return "approval-pending";
  return blockers.replyRunning ? "reply-running" : null;
};

/** Why an event the channel's state allows was refused, or null when its state refused it. */
const refusalOf = (channel: Channel, event: ChannelLifecycleEvent): ChannelArchiveRefusal | null => {
  if (event._tag === "Archive" && channel.state === "open") return archiveRefusal(event);
  if (event._tag === "Supersede" && channel.state === "open" && channel.kind === "direct") return archiveRefusal(event);
  if (event._tag === "Restore" && channel.state === "archived" && event.hobRetired) return "hob-retired";
  return null;
};

/**
 * A channel's lifecycle (ADR 037, CH-009), declared once. Neither archiving nor restoring changes
 * `updatedAt`, so a restored channel goes back to its place in the list.
 */
export const ChannelLifecycleMachine = defineMachine<ChannelState, ChannelLifecycleEvent, Channel, IllegalChannelTransition>(
  {
    name: "ChannelLifecycle",
    states: {
      open: "Takes messages and turns",
      archived: "Left out of channel lists and read-only until restored; search still finds it",
      superseded: "A chat that Start fresh replaced with a new one; read-only for good, and search still finds it",
    },
    field: "state",
    events: {
      // Refused while a reply runs or waits, while an approval waits, or when the hob is retired.
      Archive: {
        from: ["open"],
        to: "archived",
        guard: (_, e) => archiveRefusal(e) === null,
        apply: (channel, e) => new Channel({ ...channel, state: "archived", archivedAt: e.at }),
      },
      // A chat restored while its hob has opened another comes back as a camp, so the hob keeps one chat.
      Restore: {
        from: ["archived"],
        to: "open",
        guard: (_, e) => !e.hobRetired,
        apply: (channel, e) =>
          new Channel({
            ...channel,
            state: "open",
            archivedAt: null,
            kind: channel.kind === "direct" && e.chatOpen ? "camp" : channel.kind,
          }),
      },
      // Only a chat is superseded, and only when nothing would stop its archive.
      Supersede: {
        from: ["open"],
        to: "superseded",
        guard: (channel, e) => channel.kind === "direct" && archiveRefusal(e) === null,
        apply: (channel, e) => new Channel({ ...channel, state: "superseded", archivedAt: e.at, updatedAt: e.at }),
      },
    },
    illegal: (channel, event, to) =>
      new IllegalChannelTransition({ channelId: channel.id, from: channel.state, to, refusal: refusalOf(channel, event) }),
  },
);

/** `ChannelLifecycleMachine` with the questions code outside this module asks of a channel's state. */
export const ChannelLifecycle = {
  ...ChannelLifecycleMachine,
  isOpen: (channel: Channel): boolean => channel.state === "open",
  isArchived: (channel: Channel): boolean => channel.state === "archived",
  /** The hob's one open chat, which a new channel does not replace. */
  isOpenChat: (channel: Channel): boolean => channel.kind === "direct" && channel.state === "open",
};

/** Whether `session` is `agentId`'s session on `runtime` (ADR 039), whichever chapter it belongs to. */
export const isSessionOf = (session: RuntimeSession, runtime: RuntimeKind, agentId: AgentId): boolean =>
  session.runtime === runtime && session.agentId === agentId;

/**
 * The session of `agentId` on `runtime` that a turn in the channel's live chapter resumes, or undefined
 * when the hob has none there yet: a session from an earlier chapter is never resumed (ADR 037), nor
 * another hob's (ADR 039), so a hob that has not spoken in the chapter starts from the context pack.
 */
export const liveSession = (channel: Channel, runtime: RuntimeKind, agentId: AgentId): RuntimeSession | undefined =>
  channel.liveChapterId === null
    ? undefined
    : channel.sessions.find(
        (session) =>
          isSessionOf(session, runtime, agentId) &&
          session.chapterId === channel.liveChapterId &&
          (session.chapterMerges ?? 0) === channel.liveChapterMerges,
      );

/**
 * Whether a reply makes its channel unread once it lands, as the hub works it out: it ended, and it
 * says something or failed. A reply under way waits until it ends.
 */
export const leavesUnread = (message: {
  readonly role: string;
  readonly status: string;
  readonly content: string;
  /** A lead's routine progress, which the chat leaves out (#1006). */
  readonly quiet?: boolean;
}): boolean =>
  message.role === "assistant" &&
  message.quiet !== true &&
  message.status !== "queued" &&
  message.status !== "streaming" &&
  message.status !== "stopping" &&
  (message.content.trim() !== "" || message.status === "failed");

/** How long a channel's last line runs before it is cut. */
export const PREVIEW_LENGTH = 140;

/** A message's text as one line, cut at `PREVIEW_LENGTH` with an ellipsis; null when it has none. */
export const previewLine = (content: string): string | null => {
  const line = content.replace(/\s+/g, " ").trim();
  if (line.length === 0) return null;
  return line.length > PREVIEW_LENGTH ? `${line.slice(0, PREVIEW_LENGTH - 1).trimEnd()}…` : line;
};

/**
 * The line a message gives its channel's preview: null for a queued message, which the transcript
 * does not show yet, for a lead's routine progress, which it leaves out (#1006), and for one with
 * no text, such as a reply made only of tool calls.
 */
export const messagePreview = (message: {
  readonly content: string;
  readonly status: string;
  readonly quiet?: boolean;
}): string | null => (message.status === "queued" || message.quiet === true ? null : previewLine(message.content));

export const DEFAULT_CHANNEL_TITLE = "New channel";
/** The longest goal a camp takes, as long as a decision (ADR 037). */
export const CAMP_GOAL_MAX = 500;
/** The longest title a channel takes. */
export const CHANNEL_TITLE_MAX = 60;

/** Derives a channel title from the first prompt, collapsed to one line. */
export const titleFromPrompt = (prompt: string): string => {
  const line = prompt.replace(/\s+/g, " ").trim();
  if (line.length === 0) return DEFAULT_CHANNEL_TITLE;
  return line.length > CHANNEL_TITLE_MAX ? `${line.slice(0, CHANNEL_TITLE_MAX - 1).trimEnd()}…` : line;
};
