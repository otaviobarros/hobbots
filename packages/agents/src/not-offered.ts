import type { AnyOperation } from "@hobbots/domain";
import type { RuntimeEvent } from "./runtime.ts";

/**
 * The runtime's own tools as a session's offer names them (#1348): its file reads, its file edits,
 * and its commands, read-only or not.
 */
export type RuntimeToolName = "file_reads" | "file_edits" | "commands";

const OPERATIONS: Record<RuntimeToolName, AnyOperation> = {
  file_reads: "read-files",
  file_edits: "edit-files",
  commands: "run-commands",
};

/** What the hob and its reply are told of a call to a tool its session was not offered, until the hub says why. */
export const notOfferedReason = (tool: string): string => `${tool} is not offered in this session, so it did not run.`;

/**
 * A call to a tool the session was never offered, which the runtime refused before any hook of
 * Hobbots saw it (#1356), reported as a refusal so the reply and the Task show it. `runtimeTool` is
 * the runtime's own tool the name belongs to, if any; any other call, such as a hub or Charm tool
 * the session lacks, is decided as a tool outside what the hob may do, as an unknown tool is.
 */
export const notOfferedDenial = (call: {
  readonly id: string;
  readonly tool: string;
  readonly label: string;
  readonly runtimeTool: RuntimeToolName | null;
}): Extract<RuntimeEvent, { readonly _tag: "ToolDenied" }> => ({
  _tag: "ToolDenied",
  id: call.id,
  tool: call.tool,
  operation: call.runtimeTool === null ? "outside-folders" : OPERATIONS[call.runtimeTool],
  targets: [],
  label: call.label,
  reason: notOfferedReason(call.tool),
  decidedBy: "policy",
  notOffered: { runtimeTool: call.runtimeTool },
});
