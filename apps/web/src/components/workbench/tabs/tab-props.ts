import type { Attempt, AttemptActivity, Task, TaskTree } from "@hobbots/domain";
import type { HobLookup } from "../../quest/use-work.ts";
import type { TabState, WorkbenchTab } from "../workbench-model.ts";

/**
 * What every Workbench tab is given (ADR 023). The frame owns the header, the tab list and each
 * tab's label; a tab only fills its panel. Each tab stays mounted while another shows, so its
 * scroll, selection and folds are kept.
 */
export interface WorkbenchTabProps {
  readonly tree: TaskTree;
  readonly task: Task;
  /** The chosen Attempt, or null before the Task's first. */
  readonly attempt: Attempt | null;
  /** The chosen Attempt's records, or null while they load, when the read failed or with no Attempt. */
  readonly activity: AttemptActivity | null;
  /** The tab's label: Live, History or Unavailable, whose reason the frame shows above the tab. */
  readonly state: TabState;
  readonly hobs: HobLookup;
  /**
   * A file this tab shows first, by its absolute path (a change's folder and path joined by `/`, or
   * a file Artifact reference's value), as Summary's links ask; undefined for none.
   */
  readonly focus: string | undefined;
  /** Whether this tab's panel is the one showing, so a tab can wait to load what only it uses. */
  readonly shown: boolean;
  /** Shows another tab, as Summary's buttons to the tabs the Task used do, with a file to show first. */
  readonly onTab: (tab: WorkbenchTab, focus?: string) => void;
}
