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
 * The steps a reply has after a runtime event, or null when the event changes none. `now` is when a
 * tool call that starts is recorded (ISO 8601).
 *
 * Steps before `from` belong to the reply's earlier turns (before a Continue) and never change. A
 * runtime's step ids are unique within a turn only, so an id an earlier turn already used gets the
 * turn's start as a suffix: every step id stays unique within its reply.
 */
export const nextSteps = (
  steps: ReadonlyArray<ReplyStep>,
  from: number,
  event: RuntimeEvent,
  now?: string,
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
      if (event._tag === "ToolStarted") return upsert(steps, now === undefined ? step : { ...step, startedAt: now });
      return upsert(steps, { ...step, state: "denied", reason: event.reason, decidedBy: event.decidedBy });
    }
    case "ToolFinished":
      return end(steps, own(event.id), event.failed ? "failed" : "done");
    default:
      return null;
  }
};

/**
 * What a turn is told about tool calls left uncertain (EX-004): each call, and that it must check
 * before running any again. Null when there are none.
 */
export const uncertainCalls = (steps: ReadonlyArray<ReplyStep>): string | null => {
  const calls = steps.flatMap((step) => {
    if (step.state !== "uncertain" || !step.call) return [];
    const on = step.call.targets.length > 0 ? ` on ${step.call.targets.join(", ")}` : "";
    return [`- ${step.label} (${step.call.tool}, ${step.call.operation}${on})`];
  });
  if (calls.length === 0) return null;
  return [
    "Earlier in this thread, these tool calls were running when a reply was cut off, so Hobbots does not know whether they took effect:",
    ...calls,
    "Do not run any of them again until you have checked whether it took effect, and tell the user what you found.",
  ].join("\n");
};
