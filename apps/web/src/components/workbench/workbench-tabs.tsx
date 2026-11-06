import { TabsList, TabsTrigger } from "@hobbots/ui/components/tabs";
import { cn } from "@hobbots/ui/lib/utils";
import { formatCount } from "../../lib/format.ts";
import type { ListTab } from "./dock-model.ts";
import { messages } from "./messages.ts";
import { type TabState, type TabStates, WORKBENCH_TABS } from "./workbench-model.ts";

/**
 * The Workbench's tab list: a name and how many records each tab lists, once they are read.
 * A tab no hob in view used stays in place, dimmed, and says so in its hint; the Browser is marked
 * Soon; an Unavailable tab carries a lantern mark, and its panel says why. It sits inside the
 * Workbench's `Tabs`, which owns the selected tab.
 */
export function WorkbenchTabs({
  states,
  counts,
}: {
  states: TabStates;
  counts: Readonly<Record<ListTab, number>> | null;
}) {
  return (
    <TabsList aria-label={messages.tabs} variant="chip">
      {WORKBENCH_TABS.map((each) => {
        const state = states[each];
        return (
          <TabsTrigger
            key={each}
            value={each}
            variant="chip"
            title={hint(each, state)}
            className={cn(state.kind === "not-used" && "text-label")}
          >
            <span>{messages.tab[each]}</span>
            {counts !== null && each !== "browser" && state.kind !== "not-used" && (
              <span className="text-meta text-label">{formatCount(counts[each])}</span>
            )}
            <Mark state={state} />
          </TabsTrigger>
        );
      })}
    </TabsList>
  );
}

const hint = (tab: (typeof WORKBENCH_TABS)[number], state: TabState): string =>
  state.kind === "not-used" || state.kind === "unavailable" || state.kind === "coming-soon"
    ? messages.state[state.kind]
    : messages.tab[tab];

/** What sets a tab apart, if anything: Soon, Unavailable or Not used. */
function Mark({ state }: { state: TabState }) {
  if (state.kind === "coming-soon") return <span className="text-meta font-normal text-label">{messages.soon}</span>;
  if (state.kind === "unavailable") {
    return (
      <span className="flex items-center">
        <span aria-hidden className="size-1.5 rounded-dot bg-lantern" />
        <span className="sr-only">{messages.state.unavailable}</span>
      </span>
    );
  }
  if (state.kind === "not-used") return <span className="sr-only">{messages.state["not-used"]}</span>;
  return null;
}
