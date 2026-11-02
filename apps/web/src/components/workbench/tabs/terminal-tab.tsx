import type { WorkbenchTabProps } from "./tab-props.ts";

/**
 * The Terminal tab (ADR 023): The commands the Task ran and what they printed: a read-only record, with long
 * output folded.
 * Its content arrives with #389; until then the panel is an empty slot.
 */
export function TerminalTab(_props: WorkbenchTabProps) {
  return <div data-slot="terminal" className="flex flex-col gap-3 px-5 py-4" />;
}
