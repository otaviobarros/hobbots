import type { AgentId, HobChange } from "@hobbots/domain";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { changesLogQuery, hobChangesChanged, hobChangesQuery, parseChangesSeen } from "./hob-changes.ts";

const PIP = "pip" as AgentId;

// Only the time matters here: each read answers with the changes the hub had when it was taken.
const changes = (...at: ReadonlyArray<string>) => at.map((time) => ({ at: time }) as unknown as HobChange);

/** A hob's History on screen whose reads answer only when the test says so, in order. */
const watchedHistory = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pending: Array<(value: ReadonlyArray<HobChange>) => void> = [];
  const observer = new QueryObserver(client, {
    ...hobChangesQuery(PIP),
    queryFn: () => new Promise<ReadonlyArray<HobChange>>((resolve) => pending.push(resolve)),
  });
  const unsubscribe = observer.subscribe(() => {});
  const answer = (n: number, value: ReadonlyArray<HobChange>) => pending[n]?.(value);
  const shown = () => observer.getCurrentResult().data?.map((change) => change.at);
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { client, answer, shown, settled, reads: () => pending.length, unsubscribe };
};

describe("hobChangesChanged", () => {
  it("drops a first read taken before a hob changed, so the new change shows", async () => {
    const history = watchedHistory();
    expect(history.reads()).toBe(1);
    const changed = hobChangesChanged(history.client);
    await history.settled();
    expect(history.reads()).toBe(2);
    history.answer(0, changes("t1"));
    history.answer(1, changes("t2", "t1"));
    await changed;
    await history.settled();
    expect(history.shown()).toEqual(["t2", "t1"]);
    history.unsubscribe();
  });

  it("reads a loaded History again", async () => {
    const history = watchedHistory();
    history.answer(0, changes("t1"));
    await history.settled();
    expect(history.shown()).toEqual(["t1"]);
    const changed = hobChangesChanged(history.client);
    await history.settled();
    history.answer(1, changes("t2", "t1"));
    await changed;
    await history.settled();
    expect(history.shown()).toEqual(["t2", "t1"]);
    history.unsubscribe();
  });

  it("covers the Changes log too", () => {
    expect(changesLogQuery.queryKey.slice(0, 1)).toEqual(hobChangesQuery(PIP).queryKey.slice(0, 1));
  });
});

describe("parseChangesSeen", () => {
  it("keeps each hob's seen time", () => {
    expect(parseChangesSeen({ pip: "2026-11-08T10:00:00.000Z" })).toEqual({ pip: "2026-11-08T10:00:00.000Z" });
  });

  it.each([null, "pip", 3, ["pip"], { pip: 3 }, { pip: null }])("drops %j as none seen", (stored) => {
    expect(parseChangesSeen(stored)).toEqual({});
  });
});
