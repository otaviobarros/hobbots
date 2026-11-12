import type { Artifact, RegisteredArtifactKind } from "@hobbots/domain";

// The Artifacts tab's filter chips (ADR 037): each groups the registry's kinds as the sheet shows them.

export type ArtifactFilter = "all" | "code" | "pages" | "docs" | "images";

const ARTIFACT_FILTERS: ReadonlyArray<ArtifactFilter> = ["all", "code", "pages", "docs", "images"];

const KINDS: Readonly<Record<Exclude<ArtifactFilter, "all">, ReadonlySet<RegisteredArtifactKind>>> = {
  code: new Set(["code", "pr"]),
  pages: new Set(["page"]),
  docs: new Set(["doc", "email", "file"]),
  images: new Set(["image"]),
};

export const isArtifactFilter = (value: string): value is ArtifactFilter =>
  (ARTIFACT_FILTERS as ReadonlyArray<string>).includes(value);

/** The artifacts a chip leaves, in the order the hub listed them. */
export const filterArtifacts = (artifacts: ReadonlyArray<Artifact>, filter: ArtifactFilter): ReadonlyArray<Artifact> =>
  filter === "all" ? artifacts : artifacts.filter((artifact) => KINDS[filter].has(artifact.kind));

/** A link's address, for an artifact the hub keeps as a URL; null for a file or a text result. */
export const linkOf = (artifact: Pick<Artifact, "locator">): string | null =>
  /^https?:\/\//.test(artifact.locator) ? artifact.locator : null;

/** The chips a camp shows: All, and each kind it has at least one of (#1434). */
export const shownFilters = (artifacts: ReadonlyArray<Artifact>): ReadonlyArray<ArtifactFilter> =>
  ARTIFACT_FILTERS.filter((filter) => filter === "all" || filterArtifacts(artifacts, filter).length > 0);

/** The chip in effect: the one picked while the camp still has its kind, else All. */
export const filterInEffect = (artifacts: ReadonlyArray<Artifact>, picked: ArtifactFilter): ArtifactFilter =>
  shownFilters(artifacts).includes(picked) ? picked : "all";
