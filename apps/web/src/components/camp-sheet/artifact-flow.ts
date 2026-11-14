import type { ArtifactVersion, RegisteredArtifactId } from "@hobbots/domain";
import { markdownLines } from "../markdown/read.ts";
import type { ArtifactFilter } from "./artifact-rows.ts";

// Reading the camp's artifacts (ADR 037, #1434) as one reducer over a union of its steps
// (STD-REACT-029): the list, filtered by kind; one artifact open in the sheet; or the same artifact
// in the full viewer over the page. An open artifact shows its latest version until you pick another.

/** Where the reader is: the list, or one artifact in the sheet or the full viewer, at a picked version. */
export type ArtifactReading =
  | { readonly step: "list"; readonly filter: ArtifactFilter }
  | {
      readonly step: "open" | "full";
      readonly filter: ArtifactFilter;
      readonly artifactId: RegisteredArtifactId;
      /** The version picked, or null for the latest. */
      readonly version: number | null;
    };

export type ArtifactReadingEvent =
  | { readonly _tag: "Filter"; readonly filter: ArtifactFilter }
  | { readonly _tag: "Open"; readonly artifactId: RegisteredArtifactId }
  | { readonly _tag: "Pick"; readonly version: number }
  /** Opens the open artifact in the full viewer. */
  | { readonly _tag: "Expand" }
  /** Closes the full viewer, back to the artifact in the sheet. */
  | { readonly _tag: "Collapse" }
  /** Back to the list, keeping its filter. */
  | { readonly _tag: "Back" };

export const ARTIFACT_LIST: ArtifactReading = { step: "list", filter: "all" };

export const readArtifacts = (state: ArtifactReading, event: ArtifactReadingEvent): ArtifactReading => {
  switch (event._tag) {
    case "Filter":
      return state.step === "list" ? { ...state, filter: event.filter } : state;
    case "Open":
      return { step: "open", filter: state.filter, artifactId: event.artifactId, version: null };
    case "Pick":
      return state.step === "list" ? state : { ...state, version: event.version };
    case "Expand":
      return state.step === "open" ? { ...state, step: "full" } : state;
    case "Collapse":
      return state.step === "full" ? { ...state, step: "open" } : state;
    case "Back":
      return { step: "list", filter: state.filter };
  }
};

/**
 * The version an open artifact shows: the one picked while it is still listed, else the newest.
 * Null while its versions are read.
 */
export const shownVersion = (
  versions: ReadonlyArray<ArtifactVersion> | undefined,
  picked: number | null,
): ArtifactVersion | null => {
  if (versions === undefined) return null;
  return versions.find((each) => each.version === picked) ?? versions[0] ?? null;
};

/** The newest version before `version` that has contents to compare against, or null. */
export const versionBefore = (
  versions: ReadonlyArray<ArtifactVersion>,
  version: ArtifactVersion,
): ArtifactVersion | null => versions.find((each) => each.version < version.version && each.content !== "none") ?? null;

const decoder = new TextDecoder();

/** A text version's bytes, as the hub serves them (UTF-8). */
export const textOf = (bytes: Uint8Array): string => decoder.decode(bytes);

/**
 * The first lines a row previews of a text: up to `lines` that hold something, blank ones dropped,
 * each cut to `width` characters. A Markdown document is read by its parser, so a heading's marks,
 * emphasis and link targets are left out.
 */
export const firstLines = (text: string, markdown: boolean, lines = 2, width = 120): ReadonlyArray<string> => {
  const kept: Array<string> = [];
  for (const line of markdown ? markdownLines(text) : text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    kept.push(trimmed.length > width ? `${trimmed.slice(0, width - 1)}…` : trimmed);
    if (kept.length === lines) break;
  }
  return kept;
};

/**
 * A page a hob wrote, as the viewer shows it in a frame without scripts: a policy of its own lets it
 * load nothing from anywhere, so a preview never reaches the network, and it starts on a browser's
 * own light page, as it would open on its own, whatever the app's theme.
 */
export const pageDocument = (html: string): string =>
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">` +
  `<style>:root{color-scheme:light;background:Canvas;color:CanvasText}</style>${html}`;
