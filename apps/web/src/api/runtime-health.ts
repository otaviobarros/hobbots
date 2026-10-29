import type { RuntimeHealth } from "@hobbots/domain";

export const claudeInstallGuide = "https://code.claude.com/docs/en/setup";

/** What the user has to fix before the provider can run, or null when nothing is wrong. */
export const runtimeProblem = (health: RuntimeHealth | undefined): "notFound" | "notStarted" | "outdated" | null => {
  if (health === undefined) return null;
  switch (health.availability) {
    case "outdated":
      return "outdated";
    case "unavailable":
      return health.version === null ? "notFound" : "notStarted";
    default:
      return null;
  }
};

/** A ready provider is checked once a minute; one that needs fixing again on every focus or mount. */
export const runtimeStaleTime = (runtimes: ReadonlyArray<RuntimeHealth> | undefined): number =>
  runtimes?.every((health) => health.availability === "ready") ? 60_000 : 0;
