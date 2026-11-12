import { AgentId, Thread, ThreadId } from "@hobbots/domain";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { campsOf, chatStartedFresh } from "./camps.ts";
import { waitingQuestionsQuery } from "./questions.ts";

const agentId = AgentId.make("00000000-0000-4000-8000-000000000001");

const thread = (n: number, fields: Partial<{ kind: "chat" | "camp"; updatedAt: string; pinnedAt: string }>) =>
  new Thread({
    id: ThreadId.make(`00000000-0000-4000-8000-00000000010${n}`),
    agentId,
    title: `Thread ${n}`,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: fields.updatedAt ?? "2026-11-01T00:00:00.000Z",
    kind: fields.kind ?? "camp",
    pinnedAt: fields.pinnedAt ?? null,
  });

describe("campsOf", () => {
  it("lists pinned camps first, the latest pinned on top, ahead of newer activity, and leaves the chat out", () => {
    // The hob's thread list, newest activity first, as threadsQuery keeps it.
    const threads = [
      thread(1, { kind: "chat", updatedAt: "2026-11-05T00:00:00.000Z" }),
      thread(2, { updatedAt: "2026-11-04T00:00:00.000Z" }),
      thread(3, { updatedAt: "2026-11-03T00:00:00.000Z", pinnedAt: "2026-11-02T00:00:00.000Z" }),
      thread(4, { updatedAt: "2026-11-02T00:00:00.000Z" }),
      thread(5, { updatedAt: "2026-11-01T00:00:00.000Z", pinnedAt: "2026-11-03T00:00:00.000Z" }),
    ];
    expect(campsOf(threads).map((camp) => camp.title)).toEqual(["Thread 5", "Thread 3", "Thread 2", "Thread 4"]);
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

    chatStartedFresh(client, { superseded: thread(1, { kind: "chat" }), chat: thread(2, { kind: "chat" }) });

    await vi.waitFor(() => expect(calls).toEqual(["cancel", "invalidate"]));
  });
});
