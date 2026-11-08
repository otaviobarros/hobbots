import { changeShow, type LineCounts, lineCounts } from "./changes-model.ts";
import type { KeptChange } from "./task-changes.ts";
import { sideText, useTextSide } from "./use-version.ts";

/**
 * The lines a change to a text file added and removed, for its row in the Changes list. It reads
 * the same kept versions the file's diff reads, so picking the file shows it at once. Null while
 * they load, and for a file whose diff has nothing to count against: an image, a link, another
 * kind of file, or a version that was not kept.
 */
export const useLineCounts = ({ change, beforeIn, afterIn }: KeptChange): LineCounts | null => {
  const show = changeShow(change);
  const text = show === "code" || show === "document";
  const before = useTextSide(beforeIn, text ? change.before : null);
  const after = useTextSide(afterIn, text ? change.after : null);
  const was = sideText(before);
  const now = sideText(after);
  const ready = text && [before, after].every((side) => side.kind === "none" || side.kind === "text");
  return ready ? lineCounts(was, now) : null;
};
