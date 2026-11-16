import { Effect, Schema } from "effect";
import { Actor } from "./actor.ts";
import { PACK_READ_MAX, PackRead } from "./context-pack.ts";
import { AgentId, ChannelId, MessageId } from "./ids.ts";
import { defineMachine } from "./machine.ts";
import { Revision } from "./revision.ts";

/**
 * A Quest as ADR 041 decides it: work being done in a chat's or camp's main line or in a thread, with
 * a goal, "Done when" lines, one owner hob and the person who asked. A hob starts one with
 * `start_work` and ends it with `finish_work`. Until ADR 041's rollout removes the Quest of ADR 018,
 * which `quest.ts` holds, the code calls this one `WorkQuest`; the UI calls both a Quest.
 */

export const WorkQuestId = Schema.String.pipe(Schema.brand("WorkQuestId"));
export type WorkQuestId = typeof WorkQuestId.Type;

/** The most characters a Quest's title takes. */
export const WORK_QUEST_TITLE_MAX = 120;
/** The most characters a Quest's goal takes. */
export const WORK_QUEST_GOAL_MAX = 1_000;
/** The most "Done when" lines a Quest takes, and the most characters in each. */
export const WORK_QUEST_DONE_WHEN_MAX = 10;
export const WORK_QUEST_LINE_MAX = 300;
/** The most characters a finished Quest's result takes, and the most things it lists as made. */
export const WORK_QUEST_RESULT_MAX = 1_000;
export const WORK_QUEST_MADE_MAX = 20;

/** Where a Quest stands (ADR 041), held by `WorkQuestMachine`. */
export const WorkQuestState = Schema.Literals(["active", "waiting", "done", "stopped"]);
export type WorkQuestState = typeof WorkQuestState.Type;

export class WorkQuest extends Schema.Class<WorkQuest>("WorkQuest")({
  id: WorkQuestId,
  /** The chat or camp it runs in. */
  channelId: ChannelId,
  /** The thread it runs in, by the message the thread hangs from; null while it is in the main line. */
  rootMessageId: Schema.NullOr(MessageId),
  title: Schema.String,
  goal: Schema.String,
  /** Plain lines that say when it ends, at least one. */
  doneWhen: Schema.Array(Schema.String),
  /** The day it is expected by (YYYY-MM-DD), or null. */
  expectedBy: Schema.NullOr(Schema.String),
  /** The hob that runs it and answers replies that mention no one. */
  ownerHobId: AgentId,
  /** Who asked for it: the actor whose message caused the turn that started it. */
  requestedBy: Actor,
  /** The repository it works in, as the hob named it from its folders, or null for work with no code. */
  repository: Schema.NullOr(Schema.String),
  /** The reply whose turn started it, where its card shows. */
  startedFrom: MessageId,
  /**
   * What the owner's session read first, from the `PackReport` of the pack it started from (ADR 039),
   * which its card lists as "Read first". Empty when no pack is known, as after a restart.
   */
  readFirst: Schema.Array(PackRead).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
  /** Only `WorkQuestMachine` changes it, and code outside reads it through `WorkQuests`. */
  state: WorkQuestState,
  /** What the owner said it delivered, once done; null before. */
  result: Schema.NullOr(Schema.String),
  /** What the work made, such as a pull request's link or a file's path, once done. */
  made: Schema.Array(Schema.String),
  /** The reply whose turn finished it, or null while it is not done. */
  finishedFrom: Schema.NullOr(MessageId),
  createdAt: Schema.String,
  /** When its state last changed. */
  changedAt: Schema.String,
  revision: Revision,
}) {}

/** What can happen to a Quest (ADR 041). */
export type WorkQuestEvent =
  /** Its owner asked the requester something, or needs an approval. */
  | { readonly _tag: "Wait"; readonly at: string }
  /** A reply woke its owner. */
  | { readonly _tag: "Wake"; readonly at: string }
  /** Its owner said the "Done when" lines hold, in the turn writing `from`. */
  | {
      readonly _tag: "Finish";
      readonly at: string;
      readonly result: string;
      readonly made: ReadonlyArray<string>;
      readonly from: MessageId;
    }
  /** The requester or the camp's owner pressed Stop, or its hob retired at once. */
  | { readonly _tag: "Stop"; readonly at: string }
  /** Someone reopened it after a Stop. */
  | { readonly _tag: "Reopen"; readonly at: string };

/** A change to a Quest its state does not allow. */
export class IllegalWorkQuestTransition extends Schema.TaggedError<IllegalWorkQuestTransition>()(
  "IllegalWorkQuestTransition",
  { questId: WorkQuestId, from: WorkQuestState, to: WorkQuestState },
) {}

const moved = (quest: WorkQuest, state: WorkQuestState, at: string) =>
  new WorkQuest({ ...quest, state, changedAt: at });

/**
 * A Quest's lifecycle (ADR 041): four states, on purpose. A failed turn is not a state: the Quest
 * stays active until someone acts.
 */
export const WorkQuestMachine = defineMachine<WorkQuestState, WorkQuestEvent, WorkQuest, IllegalWorkQuestTransition>({
  name: "WorkQuest",
  states: {
    active: "Someone is working on it, or a reply is owed",
    waiting: "Its owner asked the requester something or needs an approval: the card shows Needs you",
    done: "Its owner said the Done when lines hold, with a short result",
    stopped: "The requester or the camp's owner pressed Stop, or its hob retired at once",
  },
  field: "state",
  events: {
    Wait: { from: ["active"], to: "waiting", apply: (quest, e) => moved(quest, "waiting", e.at) },
    Wake: { from: ["waiting", "done"], to: "active", apply: (quest, e) => moved(quest, "active", e.at) },
    Finish: {
      from: ["active", "waiting"],
      to: "done",
      apply: (quest, e) =>
        new WorkQuest({
          ...quest,
          state: "done",
          result: e.result,
          made: [...e.made],
          finishedFrom: e.from,
          changedAt: e.at,
        }),
    },
    Stop: { from: ["active", "waiting", "done"], to: "stopped", apply: (quest, e) => moved(quest, "stopped", e.at) },
    Reopen: { from: ["stopped"], to: "active", apply: (quest, e) => moved(quest, "active", e.at) },
  },
  illegal: (quest, _, to) => new IllegalWorkQuestTransition({ questId: quest.id, from: quest.state, to }),
});

/** `WorkQuestMachine` with the questions code outside this module asks of a Quest's state. */
export const WorkQuests = {
  ...WorkQuestMachine,
  /** Whether it is still running: active or waiting. A conversation holds at most one (ADR 041). */
  isRunning: (quest: WorkQuest): boolean => quest.state === "active" || quest.state === "waiting",
  isDone: (quest: WorkQuest): boolean => quest.state === "done",
};

/**
 * Why a Quest command changed nothing. `invalid`: a field is empty, too long or not a date.
 * `channel-closed`: its chat or camp is archived. `busy`: the conversation already runs a Quest.
 * `owner-leaving`: the hob is retired or retiring, so it takes no new work (#408).
 * `none-running`: there is no running Quest of the hob's in the conversation to finish.
 */
export const WorkQuestRefusal = Schema.Literals(["invalid", "channel-closed", "busy", "owner-leaving", "none-running"]);
export type WorkQuestRefusal = typeof WorkQuestRefusal.Type;

export class WorkQuestRefused extends Schema.TaggedError<WorkQuestRefused>()("WorkQuestRefused", {
  reason: WorkQuestRefusal,
  message: Schema.String,
}) {}

const invalid = (message: string) => new WorkQuestRefused({ reason: "invalid", message });

/** A text field kept trimmed, or why not. */
const keptText = (name: string, value: string, max: number): string | WorkQuestRefused => {
  const kept = value.trim();
  if (kept === "") return invalid(`Give the Quest's ${name} with some text.`);
  if (kept.length > max)
    return invalid(`A Quest's ${name} takes at most ${max} characters, and this one has ${kept.length}.`);
  return kept;
};

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `value` is a real calendar day written YYYY-MM-DD. */
export const isCalendarDay = (value: string): boolean => {
  const match = ISO_DAY.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

/** A Quest to start, as the command reads it in its transaction. */
export interface WorkQuestDraft {
  readonly id: WorkQuestId;
  readonly channelId: ChannelId;
  readonly rootMessageId: MessageId | null;
  readonly title: string;
  readonly goal: string;
  readonly doneWhen: ReadonlyArray<string>;
  readonly expectedBy: string | null;
  readonly ownerHobId: AgentId;
  readonly requestedBy: Actor;
  readonly repository: string | null;
  readonly startedFrom: MessageId;
  /** What the owner's session read first, from its pack's report. */
  readonly readFirst: ReadonlyArray<PackRead>;
  readonly at: string;
  /** Whether its chat or camp is open. */
  readonly channelOpen: boolean;
  /** Whether the hob takes new work: neither retired nor retiring. */
  readonly ownerTakesWork: boolean;
  /** The Quest the conversation already runs, if any. */
  readonly running: WorkQuest | null;
}

/** The "Done when" lines as kept: trimmed, blank ones left out, or why not. */
const keptLines = (lines: ReadonlyArray<string>): ReadonlyArray<string> | WorkQuestRefused => {
  const kept = lines.map((line) => line.trim()).filter((line) => line !== "");
  if (kept.length === 0) return invalid('Give at least one "Done when" line.');
  if (kept.length > WORK_QUEST_DONE_WHEN_MAX) {
    return invalid(
      `A Quest takes at most ${WORK_QUEST_DONE_WHEN_MAX} "Done when" lines, and this one has ${kept.length}.`,
    );
  }
  const long = kept.find((line) => line.length > WORK_QUEST_LINE_MAX);
  return long === undefined
    ? kept
    : invalid(
        `Each "Done when" line takes at most ${WORK_QUEST_LINE_MAX} characters; "${long.slice(0, 40)}…" is longer.`,
      );
};

/**
 * The pure rule of starting a Quest (ADR 041): its fields are checked and trimmed, its chat or camp
 * must be open, and its conversation must run no other Quest. It starts active.
 */
export const planWorkQuestStart = (draft: WorkQuestDraft): WorkQuest | WorkQuestRefused => {
  if (!draft.channelOpen) {
    return new WorkQuestRefused({
      reason: "channel-closed",
      message: "This chat or camp is closed, so no Quest starts here.",
    });
  }
  if (!draft.ownerTakesWork) {
    return new WorkQuestRefused({
      reason: "owner-leaving",
      message: "You are retiring, so you start no new Quest. Finish the work you already have.",
    });
  }
  if (draft.running !== null) {
    return new WorkQuestRefused({
      reason: "busy",
      message: `This conversation already runs the Quest "${draft.running.title}" (${draft.running.id}). Finish it before you start another, or ask the person whether this work belongs to it.`,
    });
  }
  const title = keptText("title", draft.title, WORK_QUEST_TITLE_MAX);
  if (title instanceof WorkQuestRefused) return title;
  const goal = keptText("goal", draft.goal, WORK_QUEST_GOAL_MAX);
  if (goal instanceof WorkQuestRefused) return goal;
  const doneWhen = keptLines(draft.doneWhen);
  if (doneWhen instanceof WorkQuestRefused) return doneWhen;
  const expectedBy = draft.expectedBy?.trim() || null;
  if (expectedBy !== null && !isCalendarDay(expectedBy)) {
    return invalid(
      `Give the expected date as a day written YYYY-MM-DD, such as 2026-12-01, not "${expectedBy.slice(0, 40)}".`,
    );
  }
  const repository = draft.repository?.trim() || null;
  return new WorkQuest({
    id: draft.id,
    channelId: draft.channelId,
    rootMessageId: draft.rootMessageId,
    title,
    goal,
    doneWhen,
    expectedBy,
    ownerHobId: draft.ownerHobId,
    requestedBy: draft.requestedBy,
    repository,
    startedFrom: draft.startedFrom,
    readFirst: draft.readFirst.slice(0, PACK_READ_MAX),
    state: "active",
    result: null,
    made: [],
    finishedFrom: null,
    createdAt: draft.at,
    changedAt: draft.at,
  });
};

/** What finishing a Quest asks. */
export interface WorkQuestFinish {
  readonly result: string;
  readonly made: ReadonlyArray<string>;
  readonly from: MessageId;
  readonly at: string;
}

/**
 * The pure rule of finishing a Quest (ADR 041): `quest` is the running Quest of the hob's in the
 * conversation, or null when there is none. Its result is checked and trimmed; it ends done.
 */
export const planWorkQuestFinish = (quest: WorkQuest | null, finish: WorkQuestFinish): WorkQuest | WorkQuestRefused => {
  if (quest === null) {
    return new WorkQuestRefused({
      reason: "none-running",
      message: "You run no Quest in this conversation, so there is nothing to finish.",
    });
  }
  const result = keptText("result", finish.result, WORK_QUEST_RESULT_MAX);
  if (result instanceof WorkQuestRefused) return result;
  const made = finish.made.map((item) => item.trim()).filter((item) => item !== "");
  if (made.length > WORK_QUEST_MADE_MAX) {
    return invalid(`List at most ${WORK_QUEST_MADE_MAX} things the work made, and this list has ${made.length}.`);
  }
  const done = WorkQuests.transition(quest, { _tag: "Finish", at: finish.at, result, made, from: finish.from });
  return done instanceof IllegalWorkQuestTransition
    ? new WorkQuestRefused({ reason: "none-running", message: `The Quest "${quest.title}" is not running.` })
    : done;
};
