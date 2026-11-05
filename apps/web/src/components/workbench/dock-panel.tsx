import type { AttemptId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { TabsContent } from "@hobbots/ui/components/tabs";
import { cn } from "@hobbots/ui/lib/utils";
import type { ComponentType, ReactNode } from "react";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { type DockSource, type HobTabState, hobStates, type ListTab } from "./dock-model.ts";
import { messages } from "./messages.ts";
import { ChangesTab } from "./tabs/changes-tab.tsx";
import { FilesTab } from "./tabs/files-tab.tsx";
import type { WorkbenchTabProps } from "./tabs/tab-props.ts";
import { TerminalTab } from "./tabs/terminal-tab.tsx";
import type { TabState, UnavailableReason, WorkbenchTab } from "./workbench-model.ts";

/** The tab that fills each panel; the Browser has none until it arrives (#382). */
const PANELS: Readonly<Record<ListTab, ComponentType<WorkbenchTabProps>>> = {
  changes: ChangesTab,
  files: FilesTab,
  terminal: TerminalTab,
};

/**
 * One tab's panel, kept mounted and hidden while another tab shows, with what each hob's label says
 * above it: why a hob's records are Unavailable, or which hobs did not use the tab.
 */
export function DockPanel({
  tab,
  on,
  state,
  props,
  file,
  from,
  labels,
  onRetry,
}: {
  tab: WorkbenchTab;
  on: boolean;
  state: TabState;
  props: Omit<WorkbenchTabProps, "state" | "focus" | "from" | "shown">;
  file: string | undefined;
  from: AttemptId | undefined;
  /** Whether to name each hob's label over the panel, as no lit Task's header names one. */
  labels: boolean;
  onRetry: () => void;
}) {
  return (
    <div inert={!on} className={cn("@container absolute inset-0 overflow-y-auto", !on && "invisible")}>
      {/*
       * A list grows past the panel and scrolls in it; the Terminal fills the panel exactly, as
       * xterm.js scrolls its own rows and fits the space it is given.
       */}
      <TabsContent value={tab} forceMount className={tab === "terminal" ? "h-full" : "min-h-full"}>
        {tab === "browser" ? (
          <Notices>
            <Notice text={messages.comingSoon} />
          </Notices>
        ) : state.kind === "unavailable" && state.reason === "unread" ? (
          <Notices>
            <Notice text={messages.dock.readFailed} onRetry={onRetry} />
          </Notices>
        ) : (
          <Fill on={tab === "terminal"}>
            {labels && <HobLabels tab={tab} sources={props.sources} hobs={props.hobs} />}
            <HobNotices tab={tab} sources={props.sources} hobs={props.hobs} />
            <Panel
              tab={tab}
              props={{ ...props, state, focus: on ? file : undefined, from: on ? from : undefined, shown: on }}
            />
          </Fill>
        )}
      </TabsContent>
    </div>
  );
}

/** The Terminal's column, which fills the panel; a list's content is left as it is. */
function Fill({ on, children }: { on: boolean; children: ReactNode }) {
  return on ? <div className="flex h-full flex-col">{children}</div> : children;
}

/**
 * Each hob's label for the tab (ADR 023), when no lit Task's header names one: Live while its work
 * may still change, History once it ended, Unavailable or Not used. One hob's work can be live while
 * another's is history, so each is named apart.
 */
function HobLabels({ tab, sources, hobs }: { tab: ListTab; sources: ReadonlyArray<DockSource>; hobs: HobLookup }) {
  const states = hobStates(sources, tab);
  if (states.length === 0) return null;
  return (
    <ul aria-label={messages.dock.labels} className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 px-5 pt-3 pb-0">
      {states.map((each) => {
        const hob = hobs(each.ownerId);
        return (
          <li key={each.ownerId} className="flex items-center gap-1.5 text-meta text-label">
            <HobTile hob={hob} tile="sm" />
            <span>{messages.dock.hobState({ name: hob.name, state: messages.dock.state[each.state.kind] })}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Panel({ tab, props }: { tab: ListTab; props: WorkbenchTabProps }) {
  const Tab = PANELS[tab];
  return <Tab {...props} />;
}

/**
 * Each hob's label for the tab, in a sentence above it (ADR 023): why its records cannot be shown,
 * and, once none of the hobs in view used the tab, that they did not. A hob that used it, or still
 * may, needs no sentence.
 */
function HobNotices({ tab, sources, hobs }: { tab: ListTab; sources: ReadonlyArray<DockSource>; hobs: HobLookup }) {
  const states = hobStates(sources, tab);
  const unavailable = states.flatMap((each) =>
    each.state.kind === "unavailable" ? [{ ownerId: each.ownerId, reason: each.state.reason }] : [],
  );
  const unused = states.every((each) => each.state.kind === "not-used") ? states : [];
  if (unavailable.length === 0 && unused.length === 0) return null;
  return (
    <Notices>
      {unavailable.map((each) => (
        <Notice key={each.ownerId} text={unavailableText(each, states.length > 1, hobs)} />
      ))}
      {unused.length > 0 && (
        <Notice text={messages.notUsed[tab]({ name: messages.names(unused.map((each) => hobs(each.ownerId).name)) })} />
      )}
    </Notices>
  );
}

const unavailableText = (
  each: { readonly ownerId: HobTabState["ownerId"]; readonly reason: UnavailableReason },
  named: boolean,
  hobs: HobLookup,
): string => {
  const reason = messages.unavailable[each.reason];
  return named ? messages.dock.hobUnavailable({ name: hobs(each.ownerId).name, reason }) : reason;
};

function Notices({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-1 px-5 pt-4">{children}</div>;
}

function Notice({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <p
      role={onRetry === undefined ? undefined : "alert"}
      className="m-0 flex items-center gap-3 text-detail text-text-secondary"
    >
      <span>{text}</span>
      {onRetry !== undefined && (
        <Button variant="chip" size="xs" onClick={onRetry}>
          {messages.tryAgain}
        </Button>
      )}
    </p>
  );
}
