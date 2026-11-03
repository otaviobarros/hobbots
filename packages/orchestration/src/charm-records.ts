import type { HubCallStep, HubTools, TaskRepository } from "@hobbots/agents";
import {
  type AgentId,
  CheckpointId,
  type EventEnvelope,
  GIT_INIT_TOOL,
  type TaskId,
  TaskToolRefused,
} from "@hobbots/domain";
import { DateTime, Effect } from "effect";
import { newId } from "./call-scope.ts";
import { type makeRefusals, showRefusal } from "./refusals.ts";

/** The chat turn a Charm call comes from, as its Task tools know it. */
export interface CharmCaller {
  readonly agentId: AgentId;
  readonly scope: string;
  /** The Task the turn works on now, if any. */
  readonly taskId: () => TaskId | null;
}

/** The folder a `git_init` call named, as the hob sent it. */
const folderOf = (input: unknown): string | null => {
  const folder = input !== null && typeof input === "object" ? (input as { readonly folder?: unknown }).folder : null;
  return typeof folder === "string" ? folder : null;
};

/**
 * Records what a turn's Charm calls, such as `git_init` and the GitHub writes, did beyond their own
 * records (#664). A refused call is recorded as a Task tool refusal is, with the code `charm-refused`
 * and what the hob was told, journaled, and its step ends as failed, so the reply and the Workbench
 * Summary show it. A repository `git_init` created is a progress checkpoint on the Task the turn works
 * on, so the hobs that read the work with `read_tasks` and the Workbench see who created it.
 */
export const makeCharmRecords = (
  tasks: TaskRepository["Service"],
  refusals: ReturnType<typeof makeRefusals>,
  announce: (entries: ReadonlyArray<EventEnvelope>) => Effect.Effect<void>,
) => {
  const refused = (caller: CharmCaller, name: string, input: unknown, text: string, step: HubCallStep | undefined) =>
    Effect.gen(function* () {
      showRefusal(step, text);
      yield* refusals.record(
        { agentId: caller.agentId, scope: caller.scope, tool: name, raw: input, taskOf: caller.taskId },
        new TaskToolRefused({ reason: "charm-refused", message: text }),
      );
    });

  const created = (caller: CharmCaller, input: unknown) =>
    Effect.gen(function* () {
      const taskId = caller.taskId();
      const folder = folderOf(input);
      if (taskId === null || folder === null) return;
      const committed = yield* tasks.recordCheckpoint({
        id: CheckpointId.make(newId()),
        taskId,
        source: "unplanned",
        kind: "progress",
        milestoneId: null,
        summary: `Created a Git repository in ${folder} with ${GIT_INIT_TOOL}.`,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
      yield* announce(committed.entries);
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Could not record a created repository", cause)));

  /** `charms`, with each call's refusal or created repository recorded for `caller`. */
  return (caller: CharmCaller) =>
    (charms: HubTools | null): HubTools | null =>
      charms === null
        ? null
        : {
            ...charms,
            call: (name, input, step) =>
              charms.call(name, input, step).pipe(
                Effect.tap((answer) => {
                  if (answer.refused) return refused(caller, name, input, answer.text, step);
                  return name === GIT_INIT_TOOL ? created(caller, input) : Effect.void;
                }),
              ),
          };
};
