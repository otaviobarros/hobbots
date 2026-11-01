import type { AgentId, ThreadId } from "@hobbots/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendDraft, moveDraft, readDraft, restoreDraft, saveDrafts, sendable, writeDraft } from "./drafts.ts";

const thread = (id: string) => id as ThreadId;
const fresh = `new-${"hob" as AgentId}` as const;

describe("sendable", () => {
  it("keeps line breaks, tabs and indentation as typed", () =>
    expect(sendable("  def run():\n\treturn 1\n\nDone")).toBe("  def run():\n\treturn 1\n\nDone"));
  it("keeps blank lines and spaces around the text", () => expect(sendable("\n hello\n")).toBe("\n hello\n"));
  it("sends nothing for whitespace alone", () => expect(sendable(" \n\t\n ")).toBe(""));
});

describe("drafts", () => {
  it("keeps a draft for each thread", () => {
    writeDraft(thread("a"), "for a");
    writeDraft(thread("b"), "for b");
    expect(readDraft(thread("a"))).toBe("for a");
    expect(readDraft(thread("b"))).toBe("for b");
  });
  it("puts a refused send back in front of what was typed since", () => {
    writeDraft(thread("c"), "typed since");
    restoreDraft(thread("c"), "refused");
    expect(readDraft(thread("c"))).toBe("refused\ntyped since");
    writeDraft(thread("d"), "");
    restoreDraft(thread("d"), "refused");
    expect(readDraft(thread("d"))).toBe("refused");
  });
  it("moves a fresh page's draft into the thread it started", () => {
    writeDraft(fresh, "still typing");
    moveDraft(fresh, thread("e"));
    expect(readDraft(fresh)).toBe("");
    expect(readDraft(thread("e"))).toBe("still typing");
  });
});

describe("saved drafts", () => {
  const stored = new Map<string, string>();
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  };
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    stored.clear();
  });

  it("saves a draft a moment after typing, and at once when the page is closing", () => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", storage);
    writeDraft(thread("s1"), "typing");
    expect(stored.has("draft.s1")).toBe(false);
    vi.advanceTimersByTime(300);
    expect(stored.get("draft.s1")).toBe(JSON.stringify("typing"));
    writeDraft(thread("s1"), "typing more");
    saveDrafts();
    expect(stored.get("draft.s1")).toBe(JSON.stringify("typing more"));
  });
  it("forgets a sent draft at once, so a reload never brings it back", () => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", storage);
    writeDraft(thread("s2"), "about to send");
    vi.advanceTimersByTime(300);
    writeDraft(thread("s2"), "");
    expect(stored.has("draft.s2")).toBe(false);
  });
  it("reads a draft saved before a reload", () => {
    vi.stubGlobal("localStorage", storage);
    stored.set("draft.s3", JSON.stringify("from before"));
    expect(readDraft(thread("s3"))).toBe("from before");
  });
});

describe("appendDraft", () => {
  it("puts a message taken back to edit after what was typed since", () => {
    writeDraft(thread("f"), "typed");
    appendDraft(thread("f"), "taken back");
    expect(readDraft(thread("f"))).toBe("typed\ntaken back");
  });
});
