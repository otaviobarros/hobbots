import type { HobbotsRepository, TaskRepository } from "@hobbots/agents";
import {
  type Agent,
  type DelegationAuthority,
  hobActor,
  liveAttemptOn,
  NoteId,
  type Task,
  type TaskToolInput,
  type TaskToolRefused,
} from "@hobbots/domain";
import { Effect } from "effect";
import { type Authority, type PathSeparator, reassignedAuthority } from "./authority.ts";
import { type CallScope, fromRecords, journalOf, memberTask, newId, refuse } from "./call-scope.ts";
import { checkMember, findHob } from "./delegating.ts";

interface Deps {
  readonly tasks: TaskRepository["Service"];
  readonly hobs: HobbotsRepository["Service"];
  readonly capacity: (scope: CallScope, ownerId: Agent["id"], adding: number) => Effect.Effect<void, TaskToolRefused>;
  readonly authority: {
    readonly of: (scope: CallScope, task: Task) => Effect.Effect<Authority>;
    readonly own: (agentId: Agent["id"]) => Effect.Effect<Authority>;
  };
  readonly separator: PathSeparator;
}

/** What to do instead when the Task is not a member's directly under the caller's own. */
const LEAD_IT = "Ask the hob that leads it instead.";

/** Refused when the Task moved on since the lead read it, so a lead never acts on what it no longer is. */
const sameRevision = (task: Task, expected: number) =>
  task.revision === expected
    ? Effect.void
    : refuse(
        "task-changed",
        `Task ${task.id} is at revision ${task.revision} now, not ${expected}: it changed since you read it. Read it with read_tasks and decide again.`,
      );

/** Refused while a turn runs on the Task: no replacement starts while the old Attempt may run. */
const nothingRunning = (scope: CallScope, task: Task) =>
  liveAttemptOn(task, scope.tree)
    ? refuse("attempt-live", `A turn is running on Task ${task.id}; wait for it to end, or cancel the Task.`)
    : Effect.void;

/**
 * The member's Task a lead's retry or reassign acts on: directly under one of the lead's, with no
 * turn running on it, at the revision the lead read.
 */
const controllable = (scope: CallScope, input: { readonly task_id: string; readonly expected_revision: number }) =>
  Effect.gen(function* () {
    const task = yield* memberTask(scope, input.task_id, LEAD_IT);
    // A running turn moves the Task's revision on, so it is named first.
    yield* nothingRunning(scope, task);
    yield* sameRevision(task, input.expected_revision);
    return task;
  });

/** The authority the hob taking a member's Task over works with (#1446); see `reassignedAuthority`. */
const authorityFor = (deps: Deps, scope: CallScope, parent: Task, given: DelegationAuthority, member: Agent) =>
  Effect.gen(function* () {
    const lead = yield* deps.authority.of(scope, parent);
    const own = yield* deps.authority.own(member.id);
    const result = reassignedAuthority(lead, given, own, deps.separator);
    if (result._tag === "Unusable") {
      return yield* refuse(
        "authority-unusable",
        `${member.name} may use none of the folders this Task works in (${result.folders.join(", ")}), so it could not do it. Pick a hob whose folders hold them.`,
      );
    }
    return result.authority;
  });

/**
 * A lead's own retry and reassign of a member's Task (#1446), which before needed your controls. Each
 * names the revision the lead read and its reason, is decided again on the records in the call's
 * transaction, and leaves the reason as the lead's note on the Task, which its hob reads next.
 */
export const makeControlling = (deps: Deps) => {
  const { tasks } = deps;

  /** The lead's reason, left on the Task for the hob that works on it next. */
  const reasonNote = (scope: CallScope, task: Task, text: string) =>
    fromRecords(
      tasks.leaveNote({
        id: NoteId.make(newId()),
        taskId: task.id,
        text,
        createdAt: scope.at,
        senderId: scope.caller.agentId,
      }),
    );

  return {
    retry_task: (scope: CallScope, input: Omit<TaskToolInput<"retry_task">, "key">) =>
      Effect.gen(function* () {
        const before = yield* controllable(scope, input);
        const journal = journalOf();
        const by = { actor: hobActor(scope.caller.agentId), reason: input.reason };
        const task = journal.keep(
          yield* fromRecords(tasks.retryTask(before.id, input.expected_revision, scope.at, by)),
        );
        journal.keep(yield* reasonNote(scope, task, `Retried: ${input.reason}`));
        return {
          done: {
            message: `Queued Task ${task.id} again for hob ${task.ownerId}, with your reason as a note. It starts a new Attempt once nothing holds it.`,
            details: { task_id: task.id as string, state: task.state, revision: task.revision },
          },
          entries: journal.entries,
        };
      }),

    reassign_task: (scope: CallScope, input: Omit<TaskToolInput<"reassign_task">, "key">) =>
      Effect.gen(function* () {
        const before = yield* controllable(scope, input);
        const parent = scope.tree.tasks.find((each) => each.id === before.parentId);
        const delegation = scope.tree.delegations.find((each) => each.childTaskId === before.id);
        if (parent === undefined || delegation === undefined) {
          return yield* refuse("not-delegated", `Task ${before.id} is not a party member's; only those change hands.`);
        }
        const member = yield* findHob(deps.hobs, input.hob);
        if (member.id === before.ownerId) {
          return yield* refuse("same-owner", `Task ${before.id} is already ${member.name}'s.`);
        }
        yield* checkMember(scope, parent, member);
        yield* deps.capacity(scope, member.id, 1);
        const authority = yield* authorityFor(deps, scope, parent, delegation.authority, member);
        const journal = journalOf();
        const by = { actor: hobActor(scope.caller.agentId), reason: input.reason, authority };
        const task = journal.keep(
          yield* fromRecords(tasks.reassignTask(before.id, input.expected_revision, member.id, scope.at, by)),
        );
        journal.keep(yield* reasonNote(scope, task, `Reassigned to you: ${input.reason}`));
        return {
          done: {
            message: `Gave Task ${task.id} to ${member.name}, which starts on it afresh with your reason as a note. What the Task did so far stays.`,
            details: { task_id: task.id as string, hob: member.name, state: task.state, revision: task.revision },
          },
          entries: journal.entries,
        };
      }),
  };
};
