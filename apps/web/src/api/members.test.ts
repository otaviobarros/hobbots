import { AgentId, type HobbotsEvent, Thread, ThreadId } from "@hobbots/domain";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { applyMembersEvent } from "./members.ts";

const thread = (id: string, kind: "chat" | "camp") =>
  new Thread({
    id: ThreadId.make(id),
    agentId: AgentId.make("aldric"),
    title: id,
    kind,
    createdAt: "2026-11-14T10:00:00.000Z",
    updatedAt: "2026-11-14T10:00:00.000Z",
  });

/** The threads whose members reports an event cancels, then reads again, in order. */
const reread = async (event: HobbotsEvent) => {
  const client = new QueryClient();
  const calls: Array<string> = [];
  const record = (name: string) => (filters?: { readonly queryKey?: ReadonlyArray<unknown> }) => {
    const [, threadId, members] = filters?.queryKey ?? [];
    if (members === "members") calls.push(`${name}:${String(threadId)}`);
    return Promise.resolve();
  };
  vi.spyOn(client, "cancelQueries").mockImplementation(record("cancel"));
  vi.spyOn(client, "invalidateQueries").mockImplementation(record("invalidate"));
  applyMembersEvent(client, event);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return calls;
};

describe("applyMembersEvent", () => {
  // covers ADR 039 (Cards every thread shares: Status and cost), #1467
  it("reads both threads' members again when a chapter moves between them, and a camp's after a turn passed there, cancelling first (#1467)", async () => {
    const chat = thread("chat", "chat");
    const camp = thread("camp", "camp");
    const moved = { _tag: "ChapterMoved", threadId: chat.id, thread: chat, camp } as unknown as HobbotsEvent;
    expect(await reread(moved)).toEqual(["cancel:chat", "cancel:camp", "invalidate:chat", "invalidate:camp"]);
    // A turn passed in the camp counts there, though it leaves no reply.
    const passed = { _tag: "TurnPassed", threadId: camp.id } as unknown as HobbotsEvent;
    expect(await reread(passed)).toEqual(["cancel:camp", "invalidate:camp"]);
  });
});
