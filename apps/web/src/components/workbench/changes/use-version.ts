import type { AttemptId, ContentId, FileVersion, NotKept } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { attemptContentQuery } from "../../../api/workbench.ts";

/**
 * One side of a text change as the tab can show it: no such side (an added file has no before),
 * its text, why it was not kept, or its read on the way or failed.
 */
export type TextSide =
  | { readonly kind: "none" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly retry: () => void }
  | { readonly kind: "not-kept"; readonly reason: NotKept }
  | { readonly kind: "text"; readonly text: string };

const decoder = new TextDecoder();
const textOf = (bytes: Uint8Array) => decoder.decode(bytes);

/**
 * Reads one version's kept text. A version that kept none says why; a read refused once the
 * Attempt's details were cleared reads as cleared, as the record would say if read again.
 */
export const useTextSide = (attemptId: AttemptId, version: FileVersion | null, cleared: boolean): TextSide => {
  const contentId = version?.contentId ?? null;
  const read = useQuery({
    ...attemptContentQuery(attemptId, contentId ?? ("" as ContentId)),
    enabled: contentId !== null,
    select: textOf,
  });
  if (version === null) return { kind: "none" };
  if (contentId === null) return { kind: "not-kept", reason: version.notKept ?? "unreadable" };
  if (read.data !== undefined) return { kind: "text", text: read.data };
  if (read.isError) return cleared ? { kind: "not-kept", reason: "cleared" } : { kind: "failed", retry: read.refetch };
  return { kind: "loading" };
};

/** The text of a side, or null when it has none to show. */
export const sideText = (side: TextSide): string | null => (side.kind === "text" ? side.text : null);
