import { cn } from "@hobbots/ui/lib/utils";
import { useRef } from "react";
import { messages } from "./messages.ts";
import { type TabState, type TabStates, tabAfterKey, WORKBENCH_TABS, type WorkbenchTab } from "./workbench-model.ts";

/** The id of a tab and of its panel, so each names the other. */
export const tabIds = (base: string, tab: WorkbenchTab) => ({
  tab: `${base}-tab-${tab}`,
  panel: `${base}-panel-${tab}`,
});

const labelTone: Record<TabState["kind"], string> = {
  live: "bg-mint text-ground",
  history: "bg-line-2 text-text-secondary",
  unavailable: "border-2 border-lantern text-lantern",
  "not-used": "text-label",
  "coming-soon": "bg-line-2 text-text-secondary",
};

/**
 * The Workbench's tab list, each tab with its label. A tab the Task did not use is greyed out but
 * still opens. Arrow keys move between tabs and Home and End go to the ends, as a tab list does.
 */
export function WorkbenchTabs({
  base,
  tab,
  states,
  onTab,
}: {
  base: string;
  tab: WorkbenchTab;
  states: TabStates;
  onTab: (tab: WorkbenchTab) => void;
}) {
  const refs = useRef<Partial<Record<WorkbenchTab, HTMLButtonElement | null>>>({});
  const onKeyDown = (event: React.KeyboardEvent) => {
    const next = tabAfterKey(tab, event.key);
    if (next === null) return;
    event.preventDefault();
    onTab(next);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={messages.tabs}
      onKeyDown={onKeyDown}
      className="flex shrink-0 gap-1 overflow-x-auto border-b-2 border-line px-4"
    >
      {WORKBENCH_TABS.map((each) => {
        const on = each === tab;
        const state = states[each];
        const ids = tabIds(base, each);
        const muted = state.kind === "not-used" || state.kind === "coming-soon";
        return (
          <button
            key={each}
            ref={(el) => {
              refs.current[each] = el;
            }}
            type="button"
            role="tab"
            id={ids.tab}
            aria-selected={on}
            aria-controls={ids.panel}
            tabIndex={on ? 0 : -1}
            onClick={() => onTab(each)}
            className={cn(
              "flex shrink-0 cursor-pointer items-center gap-2 border-0 px-3 py-2.5 text-sm font-bold whitespace-nowrap",
              on ? "bg-line text-moonlight" : "bg-transparent hover:bg-hover",
              !on && (muted ? "text-label" : "text-text-secondary hover:text-text-strong"),
            )}
          >
            <span>{messages.tab[each]}</span>
            <span className={cn("px-1.5 py-px text-xs font-bold whitespace-nowrap", labelTone[state.kind])}>
              {messages.state[state.kind]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
