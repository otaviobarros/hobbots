import { Effect, Schema } from "effect";
import type { RuntimeKind } from "./agent.ts";
import { Brain, RuntimeSession } from "./brain.ts";
import { AgentId, ChapterId, ThreadId } from "./ids.ts";
import { defineMachine } from "./machine.ts";
import { Revision } from "./revision.ts";
import { SkillTrial } from "./skills.ts";

/** What a thread is (ADR 037): a hob's one open `chat`, or a `camp` with a goal of its own. */
export const ThreadKind = Schema.Literals(["chat", "camp"]);
export type ThreadKind = typeof ThreadKind.Type;

/** Where a thread stands (ADR 037), held by `ThreadLifecycleMachine`. */
export const ThreadState = Schema.Literals(["open", "archived", "superseded"]);
export type ThreadState = typeof ThreadState.Type;

/** The thread, and the chapter in it, a camp came from. */
export const ThreadOrigin = Schema.Struct({ threadId: ThreadId, chapterId: Schema.NullOr(ChapterId) });
export type ThreadOrigin = typeof ThreadOrigin.Type;

export class Thread extends Schema.Class<Thread>("Thread")({
  id: ThreadId,
  agentId: AgentId,
  title: Schema.String,
  /**
   * A chat or a camp (ADR 037). A hob has at most one open chat, which the database holds; every
   * other thread is a camp. Threads made before kinds count as camps.
   */
  kind: ThreadKind.pipe(
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
  /** The thread and chapter a camp came from, or null. */
  origin: Schema.NullOr(ThreadOrigin).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** Where the thread stands; only `ThreadLifecycleMachine` changes it, and code outside reads it through `ThreadLifecycle`. */
  state: ThreadState.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("open" as const)),
    Schema.withConstructorDefault(Effect.succeed("open" as const)),
  ),
  /**
   * One session per runtime the thread has used, kept separate from the thread's identity (ADR 017),
   * each in the chapter it started in (ADR 037): read the one a turn resumes with `liveSession`.
   * Thread events journaled before this carry none; their Claude Code session moved here in migration 0020.
   */
  sessions: Schema.Array(RuntimeSession).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
  /**
   * The thread's live chapter (ADR 037), which new messages join and whose sessions a turn resumes.
   * Worked out when the thread is read, never stored; null only on a thread not stored yet, since
   * storing a new thread starts its first chapter.
   */
  liveChapterId: Schema.NullOr(ChapterId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** The thread's own brain, or null to think with the hob's. A thread setting: it grants nothing. */
  brain: Schema.NullOr(Brain).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * When the thread was archived, or null while it is not: a fact kept beside `state`. An archived
   * thread is left out of thread lists, takes no new messages until it is restored, and is still
   * found by search.
   */
  archivedAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * The last message the transcript shows, as one line of at most `PREVIEW_LENGTH` characters, for
   * lists of chats. Worked out when the thread is read, never stored; null while it has none.
   */
  lastLine: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * When the thread was pinned to the top of its hob's chats, or null when it is not pinned. A
   * thread setting: it grants nothing.
   */
  pinnedAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * Whether the hob wrote in the thread since the last message you read on any device (ADR 027): a
   * reply that ended after it. Worked out when the thread is read from the read marker the hub
   * keeps, never sent by a client; false for threads from before it was kept.
   */
  unread: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
    Schema.withConstructorDefault(Effect.succeed(false)),
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
 * Why a thread cannot be archived or restored now. `reply-running`: a reply is running or a
 * message waits in its queue. `approval-pending`: a tool call waits for the user's decision, which
 * wins when both apply. `hob-retired`: a retired hob's threads stay as they are, which wins over both.
 */
export const ThreadArchiveRefusal = Schema.Literals(["reply-running", "approval-pending", "hob-retired"]);
export type ThreadArchiveRefusal = typeof ThreadArchiveRefusal.Type;

/** What stops a thread from being archived, read under its hob's lock. */
export interface ArchiveBlockers {
  readonly hobRetired: boolean;
  readonly approvalPending: boolean;
  readonly replyRunning: boolean;
}

/** What can happen to a thread's lifecycle. */
export type ThreadLifecycleEvent =
  | ({ readonly _tag: "Archive"; readonly at: string } & ArchiveBlockers)
  | {
      readonly _tag: "Restore";
      readonly hobRetired: boolean;
      /** Whether the hob has another open chat, as when a new chat opened while this one was archived. */
      readonly chatOpen: boolean;
    }
  | { readonly _tag: "Supersede"; readonly at: string };

/** A change to a thread's lifecycle its state does not allow, with why when something stops it. */
export class IllegalThreadTransition extends Schema.TaggedError<IllegalThreadTransition>()("IllegalThreadTransition", {
  threadId: ThreadId,
  from: ThreadState,
  to: ThreadState,
  refusal: Schema.NullOr(ThreadArchiveRefusal),
}) {}

/** The refusal that wins among an archive's blockers, or null when none stops it. */
const archiveRefusal = (blockers: ArchiveBlockers): ThreadArchiveRefusal | null => {
  if (blockers.hobRetired) return "hob-retired";
  if (blockers.approvalPending) return "approval-pending";
  return blockers.replyRunning ? "reply-running" : null;
};

/** Why an event the thread's state allows was refused, or null when its state refused it. */
const refusalOf = (thread: Thread, event: ThreadLifecycleEvent): ThreadArchiveRefusal | null => {
  if (event._tag === "Archive" && thread.state === "open") return archiveRefusal(event);
  if (event._tag === "Restore" && thread.state === "archived" && event.hobRetired) return "hob-retired";
  return null;
};

/**
 * A thread's lifecycle (ADR 037, CH-009), declared once. Neither archiving nor restoring changes
 * `updatedAt`, so a restored thread goes back to its place in the list.
 */
export const ThreadLifecycleMachine = defineMachine<ThreadState, ThreadLifecycleEvent, Thread, IllegalThreadTransition>(
  {
    name: "ThreadLifecycle",
    states: {
      open: "Takes messages and turns",
      archived: "Left out of thread lists and read-only until restored; search still finds it",
      superseded: "A chat that Start fresh replaced with a new one",
    },
    field: "state",
    events: {
      // Refused while a reply runs or waits, while an approval waits, or when the hob is retired.
      Archive: {
        from: ["open"],
        to: "archived",
        guard: (_, e) => archiveRefusal(e) === null,
        apply: (thread, e) => new Thread({ ...thread, state: "archived", archivedAt: e.at }),
      },
      // A chat restored while its hob has opened another comes back as a camp, so the hob keeps one chat.
      Restore: {
        from: ["archived"],
        to: "open",
        guard: (_, e) => !e.hobRetired,
        apply: (thread, e) =>
          new Thread({
            ...thread,
            state: "open",
            archivedAt: null,
            kind: thread.kind === "chat" && e.chatOpen ? "camp" : thread.kind,
          }),
      },
      Supersede: {
        from: ["open"],
        to: "superseded",
        guard: (thread) => thread.kind === "chat",
        apply: (thread, e) => new Thread({ ...thread, state: "superseded", updatedAt: e.at }),
      },
    },
    illegal: (thread, event, to) =>
      new IllegalThreadTransition({ threadId: thread.id, from: thread.state, to, refusal: refusalOf(thread, event) }),
  },
);

/** `ThreadLifecycleMachine` with the questions code outside this module asks of a thread's state. */
export const ThreadLifecycle = {
  ...ThreadLifecycleMachine,
  isOpen: (thread: Thread): boolean => thread.state === "open",
  isArchived: (thread: Thread): boolean => thread.state === "archived",
  /** The hob's one open chat, which a new thread does not replace. */
  isOpenChat: (thread: Thread): boolean => thread.kind === "chat" && thread.state === "open",
};

/**
 * The thread's session on `runtime` that a turn in its live chapter resumes, or undefined when the
 * chapter has none yet: a session from an earlier chapter is never resumed (ADR 037).
 */
export const liveSession = (thread: Thread, runtime: RuntimeKind): RuntimeSession | undefined =>
  thread.liveChapterId === null
    ? undefined
    : thread.sessions.find((session) => session.runtime === runtime && session.chapterId === thread.liveChapterId);

/**
 * Whether a reply makes its thread unread once it lands, as the hub works it out: it ended, and it
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

/** How long a thread's last line runs before it is cut. */
export const PREVIEW_LENGTH = 140;

/** A message's text as one line, cut at `PREVIEW_LENGTH` with an ellipsis; null when it has none. */
export const previewLine = (content: string): string | null => {
  const line = content.replace(/\s+/g, " ").trim();
  if (line.length === 0) return null;
  return line.length > PREVIEW_LENGTH ? `${line.slice(0, PREVIEW_LENGTH - 1).trimEnd()}…` : line;
};

/**
 * The line a message gives its thread's preview: null for a queued message, which the transcript
 * does not show yet, for a lead's routine progress, which it leaves out (#1006), and for one with
 * no text, such as a reply made only of tool calls.
 */
export const messagePreview = (message: {
  readonly content: string;
  readonly status: string;
  readonly quiet?: boolean;
}): string | null => (message.status === "queued" || message.quiet === true ? null : previewLine(message.content));

export const DEFAULT_THREAD_TITLE = "New thread";
/** The longest title a thread takes. */
export const THREAD_TITLE_MAX = 60;

/** Derives a thread title from the first prompt, collapsed to one line. */
export const titleFromPrompt = (prompt: string): string => {
  const line = prompt.replace(/\s+/g, " ").trim();
  if (line.length === 0) return DEFAULT_THREAD_TITLE;
  return line.length > THREAD_TITLE_MAX ? `${line.slice(0, THREAD_TITLE_MAX - 1).trimEnd()}…` : line;
};
