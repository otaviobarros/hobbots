import { AgentId, MemoryPath, MemorySave, MemoryVersion, MessageId, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client.ts";
import { replySaves, savedLine, undoFailure } from "./memory-line-model.ts";

const pip = AgentId.make("pip");
const reply = MessageId.make("reply-1");
const save = (id: string, overrides: Partial<MemorySave> = {}) =>
  new MemorySave({
    id,
    agentId: pip,
    work: "reply:reply-1",
    key: "key",
    input: "input",
    scope: { _tag: "Hob", agentId: pip },
    path: MemoryPath.make("decisions/tuesday.md"),
    markdown: "# Launch emails go out Tuesday at 9 AM\n\nDecided with you.",
    tags: [],
    state: "saved",
    version: MemoryVersion.make("v1"),
    threadId: ThreadId.make("thread-1"),
    messageId: reply,
    createdAt: "2026-11-05T09:55:00.000Z",
    updatedAt: "2026-11-05T09:55:00.000Z",
    ...overrides,
  });

describe("replySaves", () => {
  it("keeps the reply's saves memory has or the hub kept, and none still sending or refused", () => {
    const saves = [
      save("saved"),
      save("queued", { state: "queued", version: null }),
      save("sending", { state: "sending", version: null }),
      save("refused", { state: "refused", version: null }),
      save("other reply", { messageId: MessageId.make("reply-2") }),
    ];
    expect(replySaves(saves, reply).map((kept) => kept.id)).toEqual(["saved", "queued"]);
    expect(replySaves(undefined, reply)).toEqual([]);
  });
});

describe("savedLine", () => {
  it("says what was saved with its kind and title, and offers Open and Undo only while it stands", () => {
    expect(savedLine(save("s"), "Aldric")).toEqual({
      title: "Launch emails go out Tuesday at 9 AM",
      text: "Saved to Aldric's memory · Decision: Launch emails go out Tuesday at 9 AM",
      actions: true,
    });
    expect(savedLine(save("s", { state: "queued", version: null }), "Aldric")).toMatchObject({ actions: false });
    expect(savedLine(save("s", { undoneAt: "2026-11-05T10:00:00.000Z" }), "Aldric")).toMatchObject({
      text: "Undone. Aldric's memory is back as it was.",
      actions: false,
    });
  });
});

describe("undoFailure", () => {
  it("names why Undo did not land", () => {
    expect(undoFailure(new ApiError("", "MemorySaveNotUndoable", { reason: "newer" }), "Aldric")).toMatch(
      /Aldric's memory changed after this/,
    );
    expect(undoFailure(new ApiError("", "MemorySaveNotUndoable", { reason: "undone" }), "Aldric")).toBe(
      "This was undone already.",
    );
    expect(undoFailure(new ApiError("", "MemoryNotAnswering"), "Aldric")).toMatch(/not answering/);
    expect(undoFailure(new Error("boom"), "Aldric")).toBe("Could not undo this. Try again.");
  });
});
