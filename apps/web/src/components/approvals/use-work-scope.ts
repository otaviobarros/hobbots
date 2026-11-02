import { type ApprovalRequest, offersThisTask, TaskId } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { taskTreeQuery } from "../../api/tasks.ts";
import { workScope } from "./approval-rules.ts";

const NO_TASK = TaskId.make("");

/**
 * Whether the card offers This Task or This Quest for a request, or neither (ADR 018). The request's
 * top Task is read live, so the name changes to This Quest as soon as a party joins it.
 */
export function useWorkScope(approval: ApprovalRequest): "task" | "quest" | null {
  const offered = offersThisTask(approval);
  const read = useQuery({ ...taskTreeQuery(approval.rootTaskId ?? NO_TASK), enabled: offered });
  return offered ? workScope(approval, read.data?.tree) : null;
}
