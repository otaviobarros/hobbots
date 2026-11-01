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

const UNITS = [
  { unit: "byte", size: 1 },
  { unit: "kilobyte", size: 1024 },
  { unit: "megabyte", size: 1024 * 1024 },
] as const;

/** A size in the reader's locale, in the largest unit that keeps it at 1 or more: "12 kB", "3.4 MB". */
export const formatBytes = (bytes: number, locale?: string): string => {
  const { unit, size } = UNITS.findLast((candidate) => bytes >= candidate.size) ?? UNITS[0];
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: unit === "byte" ? 0 : 1,
  }).format(bytes / size);
};
