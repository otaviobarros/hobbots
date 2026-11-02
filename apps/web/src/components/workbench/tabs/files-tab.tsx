import type { WorkbenchTabProps } from "./tab-props.ts";

/**
 * The Files tab (ADR 023): The files the Task made or touched, with previews: Show in Finder in the desktop app on
 * the hub, Download elsewhere.
 * Its content arrives with #388; until then the panel is an empty slot.
 */
export function FilesTab(_props: WorkbenchTabProps) {
  return <div data-slot="files" className="flex flex-col gap-3 px-5 py-4" />;
}
