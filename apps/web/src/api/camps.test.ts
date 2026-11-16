import { AgentId, Channel, ChannelId } from "@hobbots/domain";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { campsOf, chatStartedFresh } from "./camps.ts";
import { waitingQuestionsQuery } from "./questions.ts";

const agentId = AgentId.make("00000000-0000-4000-8000-000000000001");

const channel = (n: number, fields: Partial<{ kind: "direct" | "camp"; updatedAt: string; pinnedAt: string }>) =>
  new Channel({
    id: ChannelId.make(`00000000-0000-4000-8000-00000000010${n}`),
    ownerHobId: agentId,
    title: `Channel ${n}`,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: fields.updatedAt ?? "2026-11-01T00:00:00.000Z",
    kind: fields.kind ?? "camp",
    pinnedAt: fields.pinnedAt ?? null,
  });

describe("campsOf", () => {
  it("lists pinned camps first, the latest pinned on top, ahead of newer activity, and leaves the chat out", () => {
    // The hob's channel list, newest activity first, as channelsQuery keeps it.
    const channels = [
      channel(1, { kind: "direct", updatedAt: "2026-11-05T00:00:00.000Z" }),
      channel(2, { updatedAt: "2026-11-04T00:00:00.000Z" }),
      channel(3, { updatedAt: "2026-11-03T00:00:00.000Z", pinnedAt: "2026-11-02T00:00:00.000Z" }),
      channel(4, { updatedAt: "2026-11-02T00:00:00.000Z" }),
      channel(5, { updatedAt: "2026-11-01T00:00:00.000Z", pinnedAt: "2026-11-03T00:00:00.000Z" }),
    ];
    expect(campsOf(channels).map((camp) => camp.title)).toEqual(["Channel 5", "Channel 3", "Channel 2", "Channel 4"]);
    expect(campsOf(undefined)).toEqual([]);
  });
});

describe("chatStartedFresh", () => {
  it("cancels a questions read already on its way before reading them again (STD-REACT-012)", async () => {
    const client = new QueryClient();
    const calls: Array<string> = [];
    const key = JSON.stringify(waitingQuestionsQuery.queryKey);
    const record = (name: string) => (filters?: { readonly queryKey?: ReadonlyArray<unknown> }) => {
      if (JSON.stringify(filters?.queryKey) === key) calls.push(name);
      return Promise.resolve();
    };
    vi.spyOn(client, "cancelQueries").mockImplementation(record("cancel"));
    vi.spyOn(client, "invalidateQueries").mockImplementation(record("invalidate"));

    chatStartedFresh(client, { superseded: channel(1, { kind: "direct" }), chat: channel(2, { kind: "direct" }) });

    await vi.waitFor(() => expect(calls).toEqual(["cancel", "invalidate"]));
  });
});
