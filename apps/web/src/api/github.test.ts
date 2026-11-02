import { describe, expect, it } from "vitest";
import { githubRepositoriesQuery, REPOSITORY_WATCH, stillWatching } from "./github.ts";

describe("the repositories the app reaches", () => {
  it("[TC-GEN-039] are read again every few seconds after you go to choose them, until the list changes or the watch runs out", () => {
    const watch = { until: 1_000 + REPOSITORY_WATCH.forMs, seen: "octohob/workshop" };
    expect(stillWatching(watch, "octohob/workshop", 2_000)).toBe(true);
    // A repository was added on GitHub.
    expect(stillWatching(watch, "octohob/notes\noctohob/workshop", 2_000)).toBe(false);
    expect(stillWatching(watch, "octohob/workshop", watch.until)).toBe(false);
    expect(stillWatching(null, "octohob/workshop", 2_000)).toBe(false);

    // Hobbots has lost focus to GitHub while it watches, so the watch goes on in the background.
    expect(githubRepositoriesQuery("octohob", true)).toMatchObject({
      refetchInterval: REPOSITORY_WATCH.everyMs,
      refetchIntervalInBackground: true,
    });
    expect(githubRepositoriesQuery("octohob").refetchInterval).toBe(false);
    // Coming back to the window always reads it again, however recent the last read.
    expect(githubRepositoriesQuery("octohob")).toMatchObject({ staleTime: 0, refetchOnWindowFocus: true });
  });
});
