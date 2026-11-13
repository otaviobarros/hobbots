import type { TaskRepository } from "@hobbots/agents";
import type { Task } from "@hobbots/domain";
import { Effect, Option } from "effect";
import type { CallScope } from "./call-scope.ts";

/**
 * Whether the turn making a call is your request (#1346): it answers a message of yours in the chat,
 * or carries your answer to a question its hob asked about `task`. A turn woken by a member's report,
 * a note or a finding is neither, whatever it says.
 */
export const askedByYou = (tasks: TaskRepository["Service"], scope: CallScope, task: Task) =>
  Effect.gen(function* () {
    if (scope.caller.messageId !== undefined) return true;
    const carried = new Set<string>((scope.caller.carried ?? []).map((each) => each.itemId));
    if (carried.size === 0) return false;
    const ledger = yield* tasks.readLedger(task.id);
    return Option.match(ledger, {
      onNone: () => false,
      onSome: (read) =>
        read.open.some(
          (entry) =>
            entry._tag === "Item" &&
            carried.has(entry.item.id) &&
            entry.item.payload._tag === "answer" &&
            entry.item.payload.question.askerId === scope.caller.agentId &&
            entry.item.payload.question.answeredBy?._tag === "User",
        ),
    });
  });
