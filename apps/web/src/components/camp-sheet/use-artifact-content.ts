import type { ArtifactContentRefusal, ArtifactVersionContent, RegisteredArtifactId, ThreadId } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { artifactContentQuery, contentRefusal } from "../../api/records.ts";
import { textOf } from "./artifact-flow.ts";

/**
 * One version's text as the viewer can show it: no version asked for, its read on the way or failed
 * with a retry, the hub's reason it is not served, or the text.
 */
export type VersionText =
  | { readonly kind: "none" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly retry: () => void }
  | { readonly kind: "refused"; readonly reason: ArtifactContentRefusal | "not-found" }
  | { readonly kind: "text"; readonly text: string };

/** A version to read: its number, and where its contents are, or `unknown` before its versions are read. */
export interface VersionAsked {
  readonly version: number;
  readonly content: ArtifactVersionContent | "unknown";
}

/** Reads a version's text, or nothing for a version that is null or that nothing kept. */
export const useVersionText = (
  threadId: ThreadId,
  artifactId: RegisteredArtifactId,
  version: VersionAsked | null,
): VersionText => {
  const asked = version !== null && version.content !== "none";
  const read = useQuery({
    ...artifactContentQuery(threadId, artifactId, version?.version ?? 1, version?.content ?? "unknown"),
    enabled: asked,
    select: textOf,
  });
  if (version === null) return { kind: "none" };
  if (!asked) return { kind: "refused", reason: "not-kept" };
  if (read.data !== undefined) return { kind: "text", text: read.data };
  if (read.isError) {
    const reason = contentRefusal(read.error);
    return reason === null ? { kind: "failed", retry: () => void read.refetch() } : { kind: "refused", reason };
  }
  return { kind: "loading" };
};
