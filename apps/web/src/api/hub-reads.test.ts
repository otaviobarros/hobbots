import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

// The hub fails each read while `down` holds, and answers with nothing once it is back.
let down = true;
vi.mock("./client.ts", () => ({
  call: () =>
    down
      ? Promise.reject(new Error("hub unreachable"))
      : Promise.resolve({ runsRevision: 0, runs: [], presenceRevision: 0, hobs: [], cursor: "e.1", summaries: [] }),
}));

const { hubReadFailed, retryHubReads } = await import("./hub-reads.ts");
const { hubStatusQuery } = await import("./hub-status.ts");
const { activeSummariesQuery } = await import("./quest-summaries.ts");

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the hub's reads in the window", () => {
  // covers UX-002
  it("[TC-UX-1374-08] tells a failed status or summaries read from an empty one, and reads it again", async () => {
    down = true;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const watching = [hubStatusQuery, activeSummariesQuery].map((query) =>
      new QueryObserver(client, query as never).subscribe(() => {}),
    );
    await settled();
    expect(hubReadFailed(client)).toBe(true);

    down = false;
    await retryHubReads(client);
    expect(hubReadFailed(client)).toBe(false);
    expect(client.getQueryData(hubStatusQuery.queryKey)).toBeDefined();
    for (const stop of watching) stop();
  });

  it("finds nothing failed while every read answered", async () => {
    down = false;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const stop = new QueryObserver(client, hubStatusQuery).subscribe(() => {});
    await settled();
    expect(hubReadFailed(client)).toBe(false);
    stop();
  });
});
