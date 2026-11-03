import type { HubCallStep, HubTools, TaskRepository } from "@hobbots/agents";
import { CheckpointId, type EventEnvelope, GIT_INIT_TOOL, TaskToolRefused } from "@hobbots/domain";
import { DateTime, Effect } from "effect";
import { newId } from "./call-scope.ts";
import { type makeRefusals, type RefusedFrom, showRefusal } from "./refusals.ts";

/** The chat turn a Charm call comes from, as its Task tools know it. */
export type CharmCaller = Omit<RefusedFrom, "tool" | "raw">;

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
        { ...caller, tool: name, raw: input },
        new TaskToolRefused({ reason: "charm-refused", message: text }),
      );
    });

  /** `text` is the hob's answer, redacted, whose first sentence names where the repository is. */
  const created = (caller: CharmCaller, text: string) =>
    Effect.gen(function* () {
      const taskId = caller.taskOf();
      if (taskId === null) return;
      const committed = yield* tasks.recordCheckpoint({
        id: CheckpointId.make(newId()),
        taskId,
        source: "unplanned",
        kind: "progress",
        milestoneId: null,
        summary: `${GIT_INIT_TOOL}: ${text.split(". ")[0]}.`,
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
                  return name === GIT_INIT_TOOL ? created(caller, answer.text) : Effect.void;
                }),
              ),
          };
};
