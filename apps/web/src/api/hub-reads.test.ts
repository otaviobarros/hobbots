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
const { applyStatusFrame, hubStatusQuery } = await import("./hub-status.ts");
const { activeSummariesQuery, questSummaryChanged } = await import("./quest-summaries.ts");

const runFrame = JSON.stringify({
  _tag: "ThreadRunChanged",
  run: { threadId: "t1", run: "running", reply: "working", revision: 1 },
});
const summary = {
  questId: "q1",
  threadId: null,
  state: "active",
  tones: { needs: 0, working: 1, waiting: 0, done: 0, problem: 0, idle: 0 },
  needsYou: 0,
  readyForReview: 0,
  revision: 1,
} as never;

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

  it("[TC-UX-1374-10] keeps a failed read failed when a later event patches what it holds, until a read answers", async () => {
    down = true;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const stop = new QueryObserver(client, hubStatusQuery).subscribe(() => {});
    await settled();
    expect(hubReadFailed(client)).toBe(true);

    // A run event for another thread is no snapshot: the hob whose presence it never read is still unknown.
    applyStatusFrame(client, runFrame);
    expect(hubReadFailed(client)).toBe(true);

    down = false;
    await retryHubReads(client);
    expect(hubReadFailed(client)).toBe(false);
    stop();
  });

  it("keeps a failed summaries read again failed when a summary event patches the set", async () => {
    down = false;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const stop = new QueryObserver(client, activeSummariesQuery).subscribe(() => {});
    await settled();
    down = true;
    await client.refetchQueries({ queryKey: activeSummariesQuery.queryKey });
    expect(hubReadFailed(client)).toBe(true);

    questSummaryChanged(client, summary);
    expect(hubReadFailed(client)).toBe(true);

    down = false;
    await retryHubReads(client);
    expect(hubReadFailed(client)).toBe(false);
    stop();
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
