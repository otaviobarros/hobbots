import { Schema } from "effect";
import { type ContentId, isImageFile } from "./activity.ts";
import { type Artifact, ArtifactOrigin, RegisteredArtifactId } from "./artifact.ts";
import type { AttemptId } from "./task.ts";
import { previewOf } from "./task-files.ts";

/**
 * An artifact's versions, as the camp sheet and its viewer show them (ADR 037, #1434). A version is
 * what one record made of it: the records of one Attempt are one version. Its contents are what the
 * hub kept of that version, or, for the latest one only, the file as it is now in the hob's folders.
 */

/**
 * How an artifact is shown, the same in the sheet's row, the sheet and the full viewer: a document
 * rendered, code or text as a diff against the version before, a page or an image previewed, a link
 * as a card, or only what it is when Hobbots cannot show it.
 */
export const ArtifactShow = Schema.Literals(["document", "diff", "page", "image", "link", "none"]);
export type ArtifactShow = typeof ArtifactShow.Type;

/**
 * Where a version's contents come from: `kept` when the hub kept them as its Attempt left them, `now`
 * when only the file as it is now can show it (the latest version only), or `none` when nothing kept
 * them, such as a version a reply's steps wrote before the latest.
 */
export const ArtifactVersionContent = Schema.Literals(["kept", "now", "none"]);
export type ArtifactVersionContent = typeof ArtifactVersionContent.Type;

export class ArtifactVersion extends Schema.Class<ArtifactVersion>("ArtifactVersion")({
  /** Counted from 1, as the artifact's `latestVersion` counts. */
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** When the hub first saw it. */
  at: Schema.String,
  /** The record that made it. */
  origin: ArtifactOrigin,
  content: ArtifactVersionContent,
}) {}

/** An artifact's versions, newest first, and how each is shown. */
export class ArtifactVersions extends Schema.Class<ArtifactVersions>("ArtifactVersions")({
  artifactId: RegisteredArtifactId,
  show: ArtifactShow,
  versions: Schema.Array(ArtifactVersion),
}) {}

/** Why a version's contents are not served. */
export const ArtifactContentRefusal = Schema.Literals([
  // Nothing kept this version: only the latest is read from the hob's folders.
  "not-kept",
  // The file is not in the hob's folders now, so the hub does not read it.
  "outside-folders",
  // Its name marks it as one that may hold secrets.
  "secret",
  // Past what the hub serves.
  "too-large",
  // It is no longer a file in the hob's folders.
  "gone",
  // A link or another kind with nothing to read.
  "no-contents",
]);
export type ArtifactContentRefusal = typeof ArtifactContentRefusal.Type;

/** Whether an artifact is a link, kept by its URL. */
export const isLinkLocator = (locator: string): boolean =>
  locator.startsWith("https://") || locator.startsWith("http://");

/** Whether an artifact is a text a Task returned, kept by its result's id. */
export const isTextLocator = (locator: string): boolean => locator.startsWith("text:");

/** Whether an artifact is a file on the hub. */
export const isFileLocator = (locator: string): boolean => !isLinkLocator(locator) && !isTextLocator(locator);

/** How an artifact is shown, by where it is and what it is (see `ArtifactShow`). */
export const artifactShow = (artifact: Pick<Artifact, "kind" | "locator">): ArtifactShow => {
  const { locator } = artifact;
  if (isLinkLocator(locator)) return "link";
  if (isTextLocator(locator)) return "document";
  if (isImageFile(locator)) return "image";
  switch (previewOf(locator)) {
    case "markdown":
      return "document";
    case "text":
      return artifact.kind === "page" ? "page" : "diff";
    default:
      return "none";
  }
};

/**
 * Where the hub reads one stored version's contents from: kept contents an Attempt's file change
 * names, a text a Task returned, or nothing.
 */
export type StoredVersionSource =
  | { readonly _tag: "kept"; readonly attemptId: AttemptId; readonly contentId: ContentId }
  | { readonly _tag: "text"; readonly text: string }
  | { readonly _tag: "none" };

/** One version as the registry stores it, with where its contents are. */
export interface StoredVersion {
  readonly version: number;
  readonly at: string;
  readonly origin: ArtifactOrigin;
  readonly source: StoredVersionSource;
}

/**
 * The versions a viewer lists, newest first. A version nothing kept reads from the file now when it
 * is the latest of a file; any other says it was not kept.
 */
export const artifactVersions = (artifact: Artifact, stored: ReadonlyArray<StoredVersion>): ArtifactVersions => {
  const latest = Math.max(0, ...stored.map((each) => each.version));
  const versions = stored
    .toSorted((a, b) => b.version - a.version)
    .map(
      (each) =>
        new ArtifactVersion({
          version: each.version,
          at: each.at,
          origin: each.origin,
          content:
            each.source._tag !== "none"
              ? "kept"
              : each.version === latest && isFileLocator(artifact.locator)
                ? "now"
                : "none",
        }),
    );
  return new ArtifactVersions({ artifactId: artifact.id, show: artifactShow(artifact), versions });
};
