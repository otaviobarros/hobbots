import { TabsList, TabsTrigger } from "@hobbots/ui/components/tabs";
import { cn } from "@hobbots/ui/lib/utils";
import { messages } from "./messages.ts";
import { type TabState, type TabStates, WORKBENCH_TABS } from "./workbench-model.ts";

const labelTone: Record<TabState["kind"], string> = {
  live: "bg-mint text-ground",
  history: "bg-line-2 text-secondary-text",
  unavailable: "border-2 border-lantern text-lantern",
  "not-used": "text-label",
  "coming-soon": "bg-line-2 text-secondary-text",
};

/**
 * The Workbench's tab list, each tab with its label. A tab the Task did not use is greyed out but
 * still opens. It sits inside the Workbench's `Tabs`, which owns the selected tab.
 */
export function WorkbenchTabs({ states }: { states: TabStates }) {
  return (
    <TabsList aria-label={messages.tabs} className="px-4">
      {WORKBENCH_TABS.map((each) => {
        const state = states[each];
        const muted = state.kind === "not-used" || state.kind === "coming-soon";
        return (
          <TabsTrigger key={each} value={each} className={cn(muted && "text-label")}>
            <span>{messages.tab[each]}</span>
            <span className={cn("px-1.5 py-px text-xs font-bold whitespace-nowrap", labelTone[state.kind])}>
              {messages.state[state.kind]}
            </span>
          </TabsTrigger>
        );
      })}
    </TabsList>
  );
}
