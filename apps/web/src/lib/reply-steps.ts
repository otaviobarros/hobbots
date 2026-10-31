import type { PolicyOperation, ReplyStep } from "@hobbots/domain";
import { RULES } from "../api/safety.ts";

/**
 * The steps a reply shows. While it runs, every step; once it ends, its tool calls only, since
 * thinking says nothing about what the hob did.
 */
export const shownSteps = (steps: ReadonlyArray<ReplyStep>, inProgress: boolean): ReadonlyArray<ReplyStep> =>
  inProgress ? steps : steps.filter((step) => step.kind === "tool");

/** The Permissions tab's name for an operation, so a step and the policy use the same words. */
export const operationLabel = (operation: PolicyOperation): string =>
  RULES.find((rule) => rule.operation === operation)?.label ?? operation;
