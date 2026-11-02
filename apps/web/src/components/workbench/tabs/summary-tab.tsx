import type { WorkbenchTabProps } from "./tab-props.ts";

/**
 * The Summary tab (ADR 023): What the hob was asked, what it did, what it made and what is still open, built
 * from the hub's records with no model call.
 * Its content arrives with #386; until then the panel is an empty slot.
 */
export function SummaryTab(_props: WorkbenchTabProps) {
  return <div data-slot="summary" className="flex flex-col gap-3 px-5 py-4" />;
}
