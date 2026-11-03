import { queryOptions } from "@tanstack/react-query";
import { call } from "./client.ts";

/** Where Hobbots is published, for the About section's links. */
export const REPOSITORY_URL = "https://github.com/otaviobarros/hobbots";
export const LICENSE_URL = `${REPOSITORY_URL}/blob/main/LICENSE`;
export const DEPENDENCIES_URL = `${REPOSITORY_URL}/network/dependencies`;

export interface AboutHub {
  /** The hub's version as people read it. */
  readonly version: string;
  /** The hub computer's name, when it says. */
  readonly name: string | null;
  /** The hub's data folder; only the hub's own computer learns it (ADR 021). */
  readonly dataDir: string | null;
}

/** A checkout's server reports `development` rather than a release number. */
export const versionLabel = (version: string): string =>
  version === "development" ? "Development build" : `Hobbots ${version}`;

/** What the About section shows, from the health endpoint. */
export const aboutQuery = queryOptions({
  queryKey: ["health", "about"] as const,
  queryFn: async (): Promise<AboutHub> => {
    const health = await call((c) => c.health.health());
    return {
      version: versionLabel(health.version),
      name: health.name ?? null,
      dataDir: "dataDir" in health ? health.dataDir : null,
    };
  },
  staleTime: Number.POSITIVE_INFINITY,
});
