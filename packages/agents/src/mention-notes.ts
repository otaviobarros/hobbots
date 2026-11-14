import { type Agent, type Message, mentionTargets, NoteId, type TaskNote, type ThreadId } from "@hobbots/domain";
import { Effect, Option } from "effect";
import { EventPublisher } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";
import { TaskRepository } from "./tasks.ts";

/**
 * Your @mention of a member in a quest (#1446): the Tasks a message to the lead's chat sends your
 * note to, and the sending. Without Task records, as in a hub with no Quests, nothing is mentioned.
 */
export const makeMentionNotes = Effect.gen(function* () {
  const tasks = yield* Effect.serviceOption(TaskRepository);
  const repo = yield* HobbotsRepository;
  const bus = yield* EventPublisher;

  /** The members' Tasks `content` mentions in a Quest the chat leads; none when it mentions no one there. */
  const targets = (threadId: ThreadId, lead: Agent, content: string) =>
    Effect.gen(function* () {
      if (Option.isNone(tasks) || !content.includes("@")) return [];
      const trees = yield* tasks.value.readThreadTrees(threadId);
      if (trees.length === 0) return [];
      // Parsed as the hub parses the message it stores, so a mention in Markdown code reaches nobody.
      return mentionTargets(trees, lead.id, yield* repo.mentionsIn(content));
    });

  /**
   * Leaves `message` as your note on each Task, straight to its owner, whose turn takes it at its
   * next step, or its next turn, which it wakes. Its id follows from the message and the Task, so
   * sending it again leaves no second note.
   */
  const send = (message: Message, targeted: ReadonlyArray<{ readonly id: TaskNote["taskId"] }>) =>
    Effect.forEach(targeted, (task) =>
      Effect.gen(function* () {
        if (Option.isNone(tasks)) return;
        const committed = yield* tasks.value.leaveNote({
          id: NoteId.make(`mention:${message.id}:${task.id}`),
          taskId: task.id,
          text: message.content,
          createdAt: message.createdAt,
          messageId: message.id,
          delivery: "steer",
          ...(message.actor === null ? {} : { author: message.actor }),
          direct: true,
        });
        yield* bus.publish(committed.entries);
      }).pipe(
        // A Task that ended or changed hands meanwhile keeps the message in the chat only.
        Effect.catchTag("TaskRefused", (refused) =>
          Effect.logInfo(`Could not send a mention to Task ${task.id}: ${refused.message}`),
        ),
      ),
    );

  return { targets, send } as const;
});
