import type { AgentId, ChannelId } from "@hobbots/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendDraft, moveDraft, readDraft, restoreDraft, saveDrafts, sendable, writeDraft } from "./drafts.ts";

const channel = (id: string) => id as ChannelId;
const fresh = `new-${"hob" as AgentId}` as const;

describe("sendable", () => {
  it("keeps line breaks, tabs and indentation as typed", () =>
    expect(sendable("  def run():\n\treturn 1\n\nDone")).toBe("  def run():\n\treturn 1\n\nDone"));
  it("keeps blank lines and spaces around the text", () => expect(sendable("\n hello\n")).toBe("\n hello\n"));
  it("sends nothing for whitespace alone", () => expect(sendable(" \n\t\n ")).toBe(""));
});

describe("drafts", () => {
  it("keeps a draft for each channel", () => {
    writeDraft(channel("a"), "for a");
    writeDraft(channel("b"), "for b");
    expect(readDraft(channel("a"))).toBe("for a");
    expect(readDraft(channel("b"))).toBe("for b");
  });
  it("puts a refused send back in front of what was typed since", () => {
    writeDraft(channel("c"), "typed since");
    restoreDraft(channel("c"), "refused");
    expect(readDraft(channel("c"))).toBe("refused\ntyped since");
    writeDraft(channel("d"), "");
    restoreDraft(channel("d"), "refused");
    expect(readDraft(channel("d"))).toBe("refused");
  });
  it("moves a fresh page's draft into the channel it started", () => {
    writeDraft(fresh, "still typing");
    moveDraft(fresh, channel("e"));
    expect(readDraft(fresh)).toBe("");
    expect(readDraft(channel("e"))).toBe("still typing");
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
    writeDraft(channel("s1"), "typing");
    expect(stored.has("draft.s1")).toBe(false);
    vi.advanceTimersByTime(300);
    expect(stored.get("draft.s1")).toBe(JSON.stringify("typing"));
    writeDraft(channel("s1"), "typing more");
    saveDrafts();
    expect(stored.get("draft.s1")).toBe(JSON.stringify("typing more"));
  });
  it("forgets a sent draft at once, so a reload never brings it back", () => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", storage);
    writeDraft(channel("s2"), "about to send");
    vi.advanceTimersByTime(300);
    writeDraft(channel("s2"), "");
    expect(stored.has("draft.s2")).toBe(false);
  });
  it("reads a draft saved before a reload", () => {
    vi.stubGlobal("localStorage", storage);
    stored.set("draft.s3", JSON.stringify("from before"));
    expect(readDraft(channel("s3"))).toBe("from before");
  });
});

describe("appendDraft", () => {
  it("puts a message taken back to edit after what was typed since", () => {
    writeDraft(channel("f"), "typed");
    appendDraft(channel("f"), "taken back");
    expect(readDraft(channel("f"))).toBe("typed\ntaken back");
  });
});
