import {
  AgentId,
  MemberWork,
  NoteId,
  Quest,
  QuestId,
  Question,
  QuestionId,
  ResponsibilityLedger,
  Task,
  TaskId,
  TaskNote,
  TaskTree,
  ThreadId,
} from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import {
  AgentNotFound,
  NoteRefused,
  QuestionClosed,
  QuestionNotFound,
  QuestNotFound,
  TaskNotFound,
  ThreadNotFound,
} from "./errors.ts";
import { UserSessionOnly } from "./user-session.ts";

/**
 * A read of a Task tree, with the event stream cursor taken just before it (ADR 013). Opening the
 * stream after `cursor` replays every change the read may have missed; a change it already shows
 * comes again with the same revision, so applying it again changes nothing.
 */
export const TaskTreeRead = Schema.Struct({ cursor: Schema.String, tree: TaskTree });
export type TaskTreeRead = typeof TaskTreeRead.Type;

/** A Quest, its party in the order they joined, and the tree of the Task it sits on, with the cursor as above. */
export const QuestRead = Schema.Struct({
  cursor: Schema.String,
  quest: Quest,
  party: Schema.Array(AgentId),
  tree: TaskTree,
});
export type QuestRead = typeof QuestRead.Type;

/** The Tasks a thread's requests started, each with its tree, oldest first, with the cursor as above. */
export const ThreadTasksRead = Schema.Struct({ cursor: Schema.String, trees: Schema.Array(TaskTree) });
export type ThreadTasksRead = typeof ThreadTasksRead.Type;

/**
 * What still keeps a Task open, as its completion gate reads it (ADR 019), with the cursor as
 * above: the hub sees unfinished work without asking the hob for its status.
 */
export const LedgerRead = Schema.Struct({ cursor: Schema.String, ledger: ResponsibilityLedger });
export type LedgerRead = typeof LedgerRead.Type;

/** A hob's Tasks on other hobs' Quests, with the cursor as above. */
export const MemberWorkRead = Schema.Struct({ cursor: Schema.String, work: Schema.Array(MemberWork) });
export type MemberWorkRead = typeof MemberWorkRead.Type;

/** Tasks and Quests (ADR 018): reads only. Hobs change them through their tools; the user through the Quest tab. */
export class TasksGroup extends HttpApiGroup.make("tasks")
  .add(
    // The Task and everything under it: steps, members' Tasks, nested Quests and their records.
    HttpApiEndpoint.get("tree", "/tasks/:taskId", {
      params: { taskId: TaskId },
      success: TaskTreeRead,
      error: TaskNotFound,
    }),
    // Open children, waits, dependencies, questions, milestones, approvals and backpack items.
    HttpApiEndpoint.get("ledger", "/tasks/:taskId/ledger", {
      params: { taskId: TaskId },
      success: LedgerRead,
      error: TaskNotFound,
    }),
    HttpApiEndpoint.get("quest", "/quests/:questId", {
      params: { questId: QuestId },
      success: QuestRead,
      error: QuestNotFound,
    }),
    // The work under a thread's requests, for the card, the strip and the drawer in its chat.
    HttpApiEndpoint.get("threadTasks", "/threads/:threadId/tasks", {
      params: { threadId: ThreadId },
      success: ThreadTasksRead,
      error: ThreadNotFound,
    }),
    // What a hob does on Quests it joined as a party member: its Task, the brief and the Quest.
    HttpApiEndpoint.get("questWork", "/agents/:agentId/quest-work", {
      params: { agentId: AgentId },
      success: MemberWorkRead,
      error: AgentNotFound,
    }),
  )
  .prefix("/api") {}

/** A question no lead could answer that waits for you, with the Task it asks about. */
export const WaitingQuestion = Schema.Struct({ question: Question, task: Task });
export type WaitingQuestion = typeof WaitingQuestion.Type;

/** The questions waiting for you, oldest first, with the cursor as above. */
export const WaitingQuestionsRead = Schema.Struct({ cursor: Schema.String, questions: Schema.Array(WaitingQuestion) });
export type WaitingQuestionsRead = typeof WaitingQuestionsRead.Type;

export const AnswerQuestionPayload = Schema.Struct({
  answer: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(4000)),
});
export type AnswerQuestionPayload = typeof AnswerQuestionPayload.Type;

export const LeaveNotePayload = Schema.Struct({
  /** The command's idempotency key, which becomes the note's id: sending it again changes nothing. */
  key: NoteId.check(Schema.isNonEmpty(), Schema.isMaxLength(100)),
  text: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(4000)),
});
export type LeaveNotePayload = typeof LeaveNotePayload.Type;

/**
 * What you say about a Quest's work (ADR 018). You talk only to the lead: a question that climbed
 * every lead and reached you is answered here and goes back down the same chain to the hob that
 * asked, and a note on a member's Task goes to its lead as a message about that Task. User sessions
 * only: a hob never answers or leaves notes for you (PE-006).
 */
export class QuestionsGroup extends HttpApiGroup.make("questions")
  .add(
    HttpApiEndpoint.get("list", "/questions", { success: WaitingQuestionsRead }),
    HttpApiEndpoint.post("answer", "/questions/:questionId/answer", {
      params: { questionId: QuestionId },
      payload: AnswerQuestionPayload,
      success: Question,
      error: [QuestionNotFound, QuestionClosed],
    }),
    HttpApiEndpoint.post("leaveNote", "/tasks/:taskId/notes", {
      params: { taskId: TaskId },
      payload: LeaveNotePayload,
      success: TaskNote,
      error: [TaskNotFound, NoteRefused],
    }),
  )
  .middleware(UserSessionOnly)
  .prefix("/api") {}
