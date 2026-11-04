import { Button } from "@hobbots/ui/components/button";
import { TabsContent } from "@hobbots/ui/components/tabs";
import { cn } from "@hobbots/ui/lib/utils";
import type { ComponentType } from "react";
import { messages } from "./messages.ts";
import { ChangesTab } from "./tabs/changes-tab.tsx";
import { FilesTab } from "./tabs/files-tab.tsx";
import { SummaryTab } from "./tabs/summary-tab.tsx";
import type { WorkbenchTabProps } from "./tabs/tab-props.ts";
import { TerminalTab } from "./tabs/terminal-tab.tsx";
import type { TabState, WorkbenchTab } from "./workbench-model.ts";

/** The tab that fills each panel; the Browser has none until it arrives (#382). */
const PANELS: Readonly<Record<Exclude<WorkbenchTab, "browser">, ComponentType<WorkbenchTabProps>>> = {
  summary: SummaryTab,
  changes: ChangesTab,
  files: FilesTab,
  terminal: TerminalTab,
};

/** One tab's panel, kept mounted and hidden while another tab shows, with what its label says above it. */
export function DockPanel({
  tab,
  on,
  state,
  owner,
  props,
  file,
  onRetry,
}: {
  tab: WorkbenchTab;
  on: boolean;
  state: WorkbenchTabProps["state"];
  owner: string;
  props: Omit<WorkbenchTabProps, "state" | "focus" | "shown">;
  file: string | undefined;
  onRetry: () => void;
}) {
  return (
    <div inert={!on} className={cn("@container absolute inset-0 overflow-y-auto", !on && "invisible")}>
      <TabsContent value={tab} forceMount className="min-h-full">
        <TabNotice tab={tab} state={state} owner={owner} onRetry={onRetry} />
        {tab !== "browser" && state.kind !== "not-used" && (
          <Panel tab={tab} props={{ ...props, state, focus: on ? file : undefined, shown: on }} />
        )}
      </TabsContent>
    </div>
  );
}

function Panel({ tab, props }: { tab: Exclude<WorkbenchTab, "browser">; props: WorkbenchTabProps }) {
  const Tab = PANELS[tab];
  return <Tab {...props} />;
}

/**
 * What the label says, in a sentence above the tab: why it is Unavailable, that the Task did not
 * use it, or that it is coming.
 */
function TabNotice({
  tab,
  state,
  owner,
  onRetry,
}: {
  tab: WorkbenchTab;
  state: TabState;
  owner: string;
  onRetry: () => void;
}) {
  const text =
    state.kind === "unavailable"
      ? messages.unavailable[state.reason]
      : state.kind === "coming-soon"
        ? messages.comingSoon
        : state.kind === "not-used" && tab !== "summary" && tab !== "browser"
          ? messages.notUsed[tab]({ name: owner })
          : null;
  if (text === null) return null;
  return (
    <p className="m-0 flex items-center gap-3 px-5 pt-4 text-detail text-text-secondary">
      <span>{text}</span>
      {state.kind === "unavailable" && state.reason === "unread" && (
        <Button variant="chip" size="xs" onClick={onRetry}>
          {messages.tryAgain}
        </Button>
      )}
    </p>
  );
}
