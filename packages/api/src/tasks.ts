import { AgentId, MemberWork, Quest, QuestId, TaskId, TaskTree, ThreadId } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { AgentNotFound, QuestNotFound, TaskNotFound, ThreadNotFound } from "./errors.ts";

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
