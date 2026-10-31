import type { PolicyOperation, ReplyStep } from "@hobbots/domain";
import { RULES } from "../api/safety.ts";

/** How a step reads in a reply: its state, or `unfinished` for one the reply ended before it did. */
export type StepOutcome = ReplyStep["state"] | "unfinished";

/**
 * The steps a reply shows. While it runs, every step; once it ends, its tool calls only, since
 * thinking says nothing about what the hob did.
 */
export const shownSteps = (steps: ReadonlyArray<ReplyStep>, inProgress: boolean): ReadonlyArray<ReplyStep> =>
  inProgress ? steps : steps.filter((step) => step.kind === "tool");

/** A step still running or waiting when its reply ended never finished; its outcome is unknown. */
export const stepOutcome = (step: ReplyStep, inProgress: boolean): StepOutcome =>
  !inProgress && (step.state === "running" || step.state === "awaiting") ? "unfinished" : step.state;

/** The Permissions tab's name for an operation, so a step and the policy use the same words. */
export const operationLabel = (operation: PolicyOperation): string =>
  RULES.find((rule) => rule.operation === operation)?.label ?? operation;
