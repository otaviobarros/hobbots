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
  /** Shows another tab, as Summary's buttons to the tabs the Task used do. */
  readonly onTab: (tab: WorkbenchTab) => void;
}
