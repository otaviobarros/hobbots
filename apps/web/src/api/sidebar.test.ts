import type { SidebarRead } from "@hobbots/api";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { applySidebarEvent, sidebarChanged, sidebarQuery } from "./sidebar.ts";

// Issue #1469 (ADR 039, The sidebar): the hub sorts the sidebar; the client reads it again after an
// event that changes what it lists (STD-REACT-012).

// Only the camps' ids matter here: each read answers with the sidebar the hub had when it was taken.
const read = (...camps: ReadonlyArray<string>) =>
  ({ sidebar: { camps: camps.map((threadId) => ({ threadId })), directMessages: [] } }) as unknown as SidebarRead;

const watched = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pending: Array<(value: SidebarRead) => void> = [];
  const observer = new QueryObserver(client, {
    ...sidebarQuery,
    queryFn: () => new Promise<SidebarRead>((resolve) => pending.push(resolve)),
  });
  const unsubscribe = observer.subscribe(() => {});
  const shown = () => observer.getCurrentResult().data?.sidebar.camps.map((camp) => camp.threadId);
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { client, pending, shown, settled, unsubscribe };
};

describe("the sidebar's read", () => {
  it("[TC-UX-1469-02] drops a first read taken before a camp was made, so the new camp shows", async () => {
    const list = watched();
    const changed = sidebarChanged(list.client);
    await list.settled();
    expect(list.pending).toHaveLength(2);
    list.pending[0]?.(read());
    list.pending[1]?.(read("launch"));
    await changed;
    await list.settled();
    expect(list.shown()).toEqual(["launch"]);
    list.unsubscribe();
  });

  it("[TC-UX-1469-03] reads again after a member or thread event, and not after a message", async () => {
    const list = watched();
    list.pending[0]?.(read());
    await list.settled();
    applySidebarEvent(list.client, { _tag: "MessageDequeued" } as never);
    await list.settled();
    expect(list.pending).toHaveLength(1);
    applySidebarEvent(list.client, { _tag: "ThreadMemberAdded" } as never);
    await list.settled();
    expect(list.pending).toHaveLength(2);
    list.unsubscribe();
  });
});
