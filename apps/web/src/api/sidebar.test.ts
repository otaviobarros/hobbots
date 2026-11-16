import type { SidebarRead } from "@hobbots/api";
import { ChannelId } from "@hobbots/domain";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

// The hub answers each read in turn, when the test lets it.
const answers: Array<(value: SidebarRead) => void> = [];
vi.mock("./client.ts", () => ({
  call: () => new Promise<SidebarRead>((resolve) => answers.push(resolve)),
}));

const { applySidebarEvent, mentionsYou, sidebarChanged, sidebarQuery } = await import("./sidebar.ts");
const { startGeneration } = await import("./sync.ts");

// Issue #1469 (ADR 039, The sidebar): the hub sorts the sidebar; the client reads it again after an
// event that changes what it lists (STD-REACT-012).

// Only the camps' ids matter here: each read answers with the sidebar the hub had when it was taken.
const read = (...camps: ReadonlyArray<string>) =>
  ({ sidebar: { camps: camps.map((channelId) => ({ channelId })), directMessages: [] } }) as unknown as SidebarRead;

const watched = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pending: Array<(value: SidebarRead) => void> = [];
  const observer = new QueryObserver(client, {
    ...sidebarQuery,
    queryFn: () => new Promise<SidebarRead>((resolve) => pending.push(resolve)),
  });
  const unsubscribe = observer.subscribe(() => {});
  const shown = () => observer.getCurrentResult().data?.sidebar.camps.map((camp) => camp.channelId);
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { client, pending, shown, settled, unsubscribe };
};

describe("the sidebar's read", () => {
  it("drops a first read taken before a camp was made, so the new camp shows (#1469)", async () => {
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

  it("reads again after a member or channel event, and not after a message (#1469)", async () => {
    const list = watched();
    list.pending[0]?.(read());
    await list.settled();
    applySidebarEvent(list.client, { _tag: "MessageDequeued" } as never);
    await list.settled();
    expect(list.pending).toHaveLength(1);
    applySidebarEvent(list.client, { _tag: "ChannelMemberAdded" } as never);
    await list.settled();
    expect(list.pending).toHaveLength(2);
    list.unsubscribe();
  });

  it("takes again a read that lands after a new sync generation began, so a camp made between them shows (#1469)", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
    const reading = client.fetchQuery(sidebarQuery);
    await settled();
    // The stream reconnects at its head while the first read is still out: that read is too old.
    startGeneration(client);
    answers.shift()?.(read());
    await settled();
    answers.shift()?.(read("launch"));
    const shown = await reading;
    expect(shown.sidebar.camps.map((camp) => camp.channelId)).toEqual(["launch"]);
  });

  it("reads again when a request, a blocker, a question or a Task changes what waits on you (#1469)", async () => {
    const list = watched();
    list.pending[0]?.(read());
    await list.settled();
    for (const _tag of ["ApprovalRequested", "BackpackItemRecorded", "QuestionAsked", "TaskStateChanged"]) {
      const before = list.pending.length;
      applySidebarEvent(list.client, { _tag } as never);
      await list.settled();
      expect(list.pending).toHaveLength(before + 1);
      list.pending.at(-1)?.(read());
      await list.settled();
    }
    list.unsubscribe();
  });

  it("reads again when a person's message lands or a queued one is taken back, and not on each update of a hob's reply (#1469)", async () => {
    const list = watched();
    list.pending[0]?.(read());
    await list.settled();
    applySidebarEvent(list.client, { _tag: "MessageUpserted", message: { role: "assistant" } } as never);
    await list.settled();
    expect(list.pending).toHaveLength(1);
    applySidebarEvent(list.client, { _tag: "MessageUpserted", message: { role: "user" } } as never);
    await list.settled();
    expect(list.pending).toHaveLength(2);
    list.pending.at(-1)?.(read());
    await list.settled();
    // A queued message that starts its turn changes nothing here; one taken back takes its mention.
    applySidebarEvent(list.client, { _tag: "MessageDequeued", reason: "started" } as never);
    await list.settled();
    expect(list.pending).toHaveLength(2);
    applySidebarEvent(list.client, { _tag: "MessageDequeued", reason: "removed" } as never);
    await list.settled();
    expect(list.pending).toHaveLength(3);
    list.unsubscribe();
  });

  it("counts a mention you have not read as unread, so opening its camp marks it read (#1469)", () => {
    const camp = ChannelId.make("camp");
    const withMention = {
      sidebar: { camps: [{ channelId: camp, mentions: 1 }], directMessages: [] },
    } as unknown as SidebarRead;
    const read = {
      sidebar: { camps: [{ channelId: camp, mentions: 0 }], directMessages: [] },
    } as unknown as SidebarRead;
    expect(mentionsYou(withMention, camp)).toBe(true);
    expect(mentionsYou(read, camp)).toBe(false);
    expect(mentionsYou(withMention, ChannelId.make("other"))).toBe(false);
    expect(mentionsYou(undefined, camp)).toBe(false);
  });
});
