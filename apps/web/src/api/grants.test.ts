import type { Grant } from "@hobbots/domain";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { grantsChanged, grantsQuery } from "./grants.ts";

// Only the ids matter here: each read answers with the grants the hub had when it was taken.
const grants = (...ids: ReadonlyArray<string>) => ids.map((id) => ({ id }) as unknown as Grant);

/**
 * A grants list on screen whose reads answer only when the test says so, in order: `answer(n, …)`
 * settles the nth read with what the hub had when that read was taken.
 */
const watchedList = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pending: Array<(value: ReadonlyArray<Grant>) => void> = [];
  const observer = new QueryObserver(client, {
    ...grantsQuery,
    queryFn: () => new Promise<ReadonlyArray<Grant>>((resolve) => pending.push(resolve)),
  });
  const unsubscribe = observer.subscribe(() => {});
  const answer = (n: number, value: ReadonlyArray<Grant>) => pending[n]?.(value);
  const shown = () => observer.getCurrentResult().data?.map((grant) => grant.id);
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { client, answer, shown, settled, reads: () => pending.length, unsubscribe };
};

describe("grantsChanged", () => {
  it("drops a first read taken before a rule was saved, so the new rule shows", async () => {
    const list = watchedList();
    // The first read was taken before g2 was saved elsewhere, and answers late.
    expect(list.reads()).toBe(1);
    const changed = grantsChanged(list.client);
    await list.settled();
    expect(list.reads()).toBe(2);
    list.answer(0, grants("g1"));
    list.answer(1, grants("g1", "g2"));
    await changed;
    await list.settled();
    expect(list.shown()).toEqual(["g1", "g2"]);
    list.unsubscribe();
  });

  it("drops a first read taken before a rule was removed, so the removed rule goes", async () => {
    const list = watchedList();
    const changed = grantsChanged(list.client);
    await list.settled();
    list.answer(1, grants());
    list.answer(0, grants("g1"));
    await changed;
    await list.settled();
    expect(list.shown()).toEqual([]);
    list.unsubscribe();
  });

  it("reads the list again once it is loaded", async () => {
    const list = watchedList();
    list.answer(0, grants("g1"));
    await list.settled();
    expect(list.shown()).toEqual(["g1"]);
    const changed = grantsChanged(list.client);
    await list.settled();
    list.answer(1, grants());
    await changed;
    expect(list.shown()).toEqual([]);
    list.unsubscribe();
  });
});
