import {
  type ArtifactContentRefusal,
  type ArtifactVersionContent,
  previewMediaType,
  type RegisteredArtifactId,
  type ThreadId,
} from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { Base64 } from "effect/encoding";
import { artifactContentQuery, contentRefusal } from "../../api/records.ts";
import { textOf } from "./artifact-flow.ts";

/**
 * One version's contents as the viewer can show them: no version asked for, its read on the way or
 * failed with a retry, the hub's reason it is not served, or what was read.
 */
export type VersionRead<A> =
  | { readonly kind: "none" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly retry: () => void }
  | { readonly kind: "refused"; readonly reason: ArtifactContentRefusal | "not-found" }
  | { readonly kind: "read"; readonly value: A };

/** One version's text, as a document, code or a page shows it. */
export type VersionText = VersionRead<string>;

/** A version to read: its number, and where its contents are, or `unknown` before its versions are read. */
export interface VersionAsked {
  readonly version: number;
  readonly content: ArtifactVersionContent | "unknown";
}

/** Reads a version's contents, or nothing for a version that is null or that nothing kept. */
const useVersionRead = <A>(
  threadId: ThreadId,
  artifactId: RegisteredArtifactId,
  version: VersionAsked | null,
  select: (bytes: Uint8Array) => A,
): VersionRead<A> => {
  const asked = version !== null && version.content !== "none";
  const read = useQuery({
    ...artifactContentQuery(threadId, artifactId, version?.version ?? 1, version?.content ?? "unknown"),
    enabled: asked,
    select,
  });
  if (version === null) return { kind: "none" };
  if (!asked) return { kind: "refused", reason: "not-kept" };
  if (read.data !== undefined) return { kind: "read", value: read.data };
  if (read.isError) {
    const reason = contentRefusal(read.error);
    return reason === null ? { kind: "failed", retry: () => void read.refetch() } : { kind: "refused", reason };
  }
  return { kind: "loading" };
};

/** Reads a version's text (UTF-8, redacted and cut by the hub). */
export const useVersionText = (
  threadId: ThreadId,
  artifactId: RegisteredArtifactId,
  version: VersionAsked | null,
): VersionText => useVersionRead(threadId, artifactId, version, textOf);

/**
 * Reads an image version's bytes and gives them to the page as a `data:` URL of the image's own type,
 * which the app's policy lets an image load. A read that fails or is refused says so, as a text
 * version's does (STD-UI-009), instead of a broken image.
 */
export const useVersionImage = (
  threadId: ThreadId,
  artifactId: RegisteredArtifactId,
  locator: string,
  version: VersionAsked,
): VersionRead<string> => {
  const type = previewMediaType(locator) ?? "image/png";
  const select = (bytes: Uint8Array) => `data:${type};base64,${Base64.encode(bytes)}`;
  return useVersionRead(threadId, artifactId, version, select);
};
