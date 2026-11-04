import type { TaskTree } from "@hobbots/domain";
import type { HobLookup } from "../../quest/use-work.ts";
import type { DockSource } from "../dock-model.ts";
import type { TabState, WorkbenchTab } from "../workbench-model.ts";

/**
 * What every Workbench tab is given (ADR 023, ADR 027). The dock owns the strip, the filter and each
 * tab's label; a tab only fills its panel, with every hob's work in view in one list. Each tab stays
 * mounted while another shows, so its scroll, selection and folds are kept.
 */
export interface WorkbenchTabProps {
  readonly tree: TaskTree;
  /** Each Task's shown Attempt in view, in tree order: every hob's, or the lit lane's. */
  readonly sources: ReadonlyArray<DockSource>;
  /** The tab's label across the hobs in view, whose reasons the dock shows above the tab. */
  readonly state: TabState;
  readonly hobs: HobLookup;
  /**
   * A file this tab shows first, by its absolute path (a change's folder and path joined by `/`, or
   * a file Artifact reference's value), as a link to it asks; undefined for none.
   */
  readonly focus: string | undefined;
  /** Whether this tab's panel is the one showing, so a tab can wait to load what only it uses. */
  readonly shown: boolean;
  /** Shows another tab, with a file to show first, as See changes in Files does. */
  readonly onTab: (tab: WorkbenchTab, focus?: string) => void;
}
