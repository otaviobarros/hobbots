import type { MemoryShare } from "@hobbots/domain";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { memorySharesChanged, memorySharesQuery } from "./memory-shares.ts";

// Only ids matter here: each read answers with what the hub had when it was taken.
const share = (id: string) => ({ id, state: "waiting" }) as unknown as MemoryShare;

/** The shares on screen, whose reads answer only when the test says so. */
const watchedList = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pending: Array<(value: { shares: ReadonlyArray<MemoryShare> }) => void> = [];
  const observer = new QueryObserver(client, {
    ...memorySharesQuery,
    queryFn: () => new Promise<{ shares: ReadonlyArray<MemoryShare> }>((resolve) => pending.push(resolve)),
  });
  const unsubscribe = observer.subscribe(() => {});
  const answer = (n: number, shares: ReadonlyArray<MemoryShare>) => pending[n]?.({ shares });
  const shown = () => observer.getCurrentResult().data?.map((each) => each.id);
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { client, answer, shown, settled, reads: () => pending.length, unsubscribe };
};

describe("memorySharesChanged", () => {
  // covers ADR 028 (Sharing), #960
  it("[TC-UX-984] drops a first read taken before a hob asked to share, so the share shows", async () => {
    const list = watchedList();
    await list.settled();
    const changed = memorySharesChanged(list.client);
    await list.settled();
    expect(list.reads()).toBe(2);
    list.answer(1, [share("s1")]);
    list.answer(0, []);
    await changed;
    await list.settled();
    expect(list.shown()).toEqual(["s1"]);
    list.unsubscribe();
  });
});
