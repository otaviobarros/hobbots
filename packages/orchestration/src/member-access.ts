import type { ToolAccess } from "@hobbots/agents";
import { ancestorsOf, type DelegationAuthority, type Task, type TaskTree } from "@hobbots/domain";
import { type PathSeparator, sharedFolders } from "./authority.ts";

/**
 * A member's tools, narrowed by every Delegation on the way down to its Task (ADR 018): each adds
 * the answers it gives as a restriction, and the member keeps only the folders each one allows. A
 * Delegation holds only the answers given on purpose, so a restriction's Ask is never answered by
 * a grant, while the member's own preset Ask still can be (ADR 015).
 */
export const delegatedAccess = (
  access: ToolAccess | null,
  task: Task,
  tree: TaskTree,
  separator: PathSeparator,
): ToolAccess | null => {
  const path = new Set<string>([task.id, ...ancestorsOf(task, tree.tasks).map((each) => each.id)]);
  const given = tree.delegations.filter((delegation) => path.has(delegation.childTaskId));
  return accessGiven(
    access,
    given.map((delegation) => delegation.authority),
    separator,
  );
};

/**
 * A hob's tools narrowed by `given`, the authority of each Delegation on the way down to a Task,
 * top first: how a member's session reads its access, and how a delegation shows its lead the
 * tools a member it has not started yet will get (#1348).
 */
export const accessGiven = (
  access: ToolAccess | null,
  given: ReadonlyArray<DelegationAuthority>,
  separator: PathSeparator,
): ToolAccess | null => {
  if (access === null) return null;
  const restrictions = [...access.policy.restrictions, ...given.map((authority) => authority.overrides)];
  const narrowing = given.flatMap((authority) => (authority.folders === null ? [] : [authority.folders]));
  if (narrowing.length === 0) return { ...access, policy: { ...access.policy, restrictions } };
  const folders = narrowing.reduce((kept, allowed) => sharedFolders(kept, allowed, separator), access.folders);
  // The policy engine reads its folders from the policy, not from the access: the member's
  // folders become the only ones it may reach, its own and hidden ones folded into them.
  return {
    ...access,
    policy: {
      ...access.policy,
      restrictions,
      sharedFolders: folders,
      hob: { ...access.policy.hob, ownFolders: [], hiddenSharedFolders: [] },
    },
    folders,
  };
};
