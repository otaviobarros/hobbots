import type { WorkbenchTabProps } from "./tab-props.ts";

/**
 * The Changes tab (ADR 023): Each file the Task added, edited, deleted or moved, with a before and after.
 * Its content arrives with #387; until then the panel is an empty slot.
 */
export function ChangesTab(_props: WorkbenchTabProps) {
  return <div data-slot="changes" className="flex flex-col gap-3 px-5 py-4" />;
}
