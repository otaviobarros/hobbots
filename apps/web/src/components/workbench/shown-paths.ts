import { foldersOverlap, type TaskTree, type TreeActivity } from "@hobbots/domain";
import { folderName } from "../quest/member-folders.ts";

/** Whether `inner` is `outer` or sits inside it. */
const within = (inner: string, outer: string) => outer.length <= inner.length && foldersOverlap(inner, outer);

/**
 * The folders the Workbench shows a Quest's paths from (#643): the folders its Quests work in and
 * every folder a Task in its tree changed or touched files in, less any folder another of them
 * holds. A member narrowed to a subfolder records its paths from there, its lead from the folder
 * above; read from the same root, one file reads the same in both. The whole tree is counted, not
 * just the hobs in view, so a path reads the same whichever lane is lit.
 */
export const questRoots = (tree: TaskTree, read: TreeActivity): ReadonlyArray<string> => {
  const folders = new Set([
    ...tree.quests.flatMap((quest) => quest.limits.folders ?? []),
    ...read.attempts.flatMap((each) => [
      ...each.activity.changes.map((change) => change.folder),
      ...each.files.map((file) => file.folder),
    ]),
  ]);
  return [...folders].filter((folder) => ![...folders].some((other) => other !== folder && within(folder, other)));
};

/** A path inside a hob's folder as the Workbench shows it: the root it is read from, and the path from there. */
export interface ShownPath {
  readonly root: string;
  /** From the root, with `/` between names. */
  readonly path: string;
}

/** Where `path`, inside `folder`, reads from the outermost of `roots` that holds the folder; from the folder itself when none does. */
export const shownPath = (roots: ReadonlyArray<string>, folder: string, path: string): ShownPath => {
  const root = roots.find((each) => within(folder, each));
  if (root === undefined || root.length === folder.length) return { root: folder, path };
  const below = folder
    .slice(root.length)
    .split(/[\\/]/)
    .filter((part) => part !== "");
  return { root, path: [...below, path].join("/") };
};

/**
 * The folders above a shown file, for a list's second line, ending with `/`: led by its root's
 * name when the list holds files from more than one root, so each says which folder it is in.
 */
export const shownDir = (shown: ShownPath, manyRoots: boolean): string => {
  const slash = shown.path.lastIndexOf("/");
  const dir = slash < 0 ? "" : shown.path.slice(0, slash + 1);
  return manyRoots ? `${folderName(shown.root)}/${dir}` : dir;
};
