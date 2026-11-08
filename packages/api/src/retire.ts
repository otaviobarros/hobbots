import {
  AgentId,
  ApprovalId,
  BackpackItemId,
  BackpackItemKind,
  RetireWork,
  TaskId,
  TaskRefusal,
  TaskState,
  ThreadId,
} from "@hobbots/domain";
import { Schema } from "effect";

/** Why one of the hob's open Tasks cannot go to the hob it would be handed to, by Reassign's rules. */
export const HandOverBlock = Schema.Struct({ reason: TaskRefusal, message: Schema.String });
export type HandOverBlock = typeof HandOverBlock.Type;

/** One Task the hob owns that has not ended. */
export const OpenTask = Schema.Struct({
  id: TaskId,
  brief: Schema.String,
  state: TaskState,
  /**
   * With `handOverTo` asked: null when the Task can go to that hob, otherwise why not. Left out
   * when no hob was named.
   */
  handOver: Schema.optionalKey(Schema.NullOr(HandOverBlock)),
});
export type OpenTask = typeof OpenTask.Type;

/** An approval the hob's work waits on. Retiring it in any way but "finish first" expires it. */
export const OpenApproval = Schema.Struct({ id: ApprovalId, label: Schema.String, threadId: ThreadId });
export type OpenApproval = typeof OpenApproval.Type;

/** An item still open in the hob's backpack. Retiring it fails what nobody else takes, as a blocker. */
export const OpenBackpackItem = Schema.Struct({
  id: BackpackItemId,
  kind: BackpackItemKind,
  taskId: Schema.NullOr(TaskId),
});
export type OpenBackpackItem = typeof OpenBackpackItem.Type;

/** What a hob still has open, which Retire lists before you choose how it retires (#408). */
export const OpenWork = Schema.Struct({
  agentId: AgentId,
  tasks: Schema.Array(OpenTask),
  approvals: Schema.Array(OpenApproval),
  backpackItems: Schema.Array(OpenBackpackItem),
});
export type OpenWork = typeof OpenWork.Type;

/**
 * How Retire treats the hob's work (#408): what happens to its running replies when it retires at
 * once; stopping it and handing each open Task to another hob; or finishing its open Tasks first.
 */
export const RetireAgentPayload = Schema.Union([
  Schema.Struct({ activeWork: RetireWork }),
  Schema.Struct({ openWork: Schema.Literal("hand-over"), handOverTo: AgentId }),
  Schema.Struct({ openWork: Schema.Literal("finish-first") }),
]);
export type RetireAgentPayload = typeof RetireAgentPayload.Type;

/**
 * A hand-over that cannot be made, so nothing changed: the hob to take the work is the one
 * retiring, missing, or does not take new work, or some open Tasks cannot go to it.
 */
export class HandOverRefused extends Schema.TaggedError<HandOverRefused>()(
  "HandOverRefused",
  {
    agentId: AgentId,
    handOverTo: AgentId,
    message: Schema.String,
    tasks: Schema.Array(Schema.Struct({ id: TaskId, brief: Schema.String, block: HandOverBlock })),
  },
  { httpApiStatus: 409 },
) {}
