import type { ReplyStep } from "@hobbots/domain";
import type { RuntimeEvent } from "./runtime.ts";

/** Replaces the step with `step.id`, merged into it, or appends `step` when there is none. */
const upsert = (steps: ReadonlyArray<ReplyStep>, step: ReplyStep): ReadonlyArray<ReplyStep> => {
  const index = steps.findIndex((existing) => existing.id === step.id);
  if (index === -1) return [...steps, step];
  return steps.map((existing, i) => (i === index ? { ...existing, ...step } : existing));
};

/**
 * Moves the running step `id` to `state`. A step that already ended keeps its outcome, and then
 * nothing changes (null).
 */
const end = (
  steps: ReadonlyArray<ReplyStep>,
  id: string,
  state: "done" | "failed",
): ReadonlyArray<ReplyStep> | null => {
  const index = steps.findIndex((step) => step.id === id && step.state === "running");
  if (index === -1) return null;
  return steps.map((step, i) => (i === index ? { ...step, state } : step));
};

/**
 * The steps a reply has after a runtime event, or null when the event changes none.
 *
 * Steps before `from` belong to the reply's earlier turns (before a Continue) and never change. A
 * runtime's step ids are unique within a turn only, so an id an earlier turn already used gets the
 * turn's start as a suffix: every step id stays unique within its reply.
 */
export const nextSteps = (
  steps: ReadonlyArray<ReplyStep>,
  from: number,
  event: RuntimeEvent,
): ReadonlyArray<ReplyStep> | null => {
  const own = (id: string) => (steps.slice(0, from).some((step) => step.id === id) ? `${id}@${from}` : id);
  switch (event._tag) {
    case "StepStarted":
      return upsert(steps, { id: own(event.id), kind: event.kind, label: event.label, state: "running" });
    case "StepEnded":
      return end(steps, own(event.id), "done");
    case "ToolAwaitingApproval":
    case "ToolStarted":
    case "ToolDenied": {
      const call = { tool: event.tool, operation: event.operation, targets: event.targets };
      const step: ReplyStep = { id: own(event.id), kind: "tool", label: event.label, state: "running", call };
      if (event._tag === "ToolAwaitingApproval") {
        return upsert(steps, { ...step, state: "awaiting", approvalId: event.approvalId });
      }
      if (event._tag === "ToolStarted") return upsert(steps, step);
      return upsert(steps, { ...step, state: "denied", reason: event.reason, decidedBy: event.decidedBy });
    }
    case "ToolFinished":
      return end(steps, own(event.id), event.failed ? "failed" : "done");
    default:
      return null;
  }
};
