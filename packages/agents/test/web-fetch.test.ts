import { TaskId, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { briefWriterOf, foundUrlKey, pageAnswer, pageParts, urlsIn, webWorkOf } from "../src/web-fetch.ts";

// The pure rules of web_fetch (ADR 036): which URLs a text holds, whose session wrote a brief, and how
// a long page is cut into parts.

describe("web_fetch's found URLs (ADR 036)", () => {
  it("keys a URL without its fragment, and only http and https ones", () => {
    expect(foundUrlKey(" https://Example.com/a?b=1#top ")).toBe("https://example.com/a?b=1");
    expect(foundUrlKey("ftp://example.com/")).toBeNull();
    expect(foundUrlKey("not a url")).toBeNull();
  });

  it("finds each URL in prose once, without the marks the sentence ends with", () => {
    const text = [
      "See https://example.com/a. And (https://example.com/b), or https://en.wikipedia.org/wiki/Lamp_(light)!",
      "Again https://example.com/a#later, and `https://example.com/c`, and javascript:alert(1).",
    ].join("\n");
    expect(urlsIn(text)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://en.wikipedia.org/wiki/Lamp_(light)",
      "https://example.com/c",
    ]);
  });

  it("keeps a found set by the chat, or by the Task a session outside a chat works on", () => {
    expect(webWorkOf({ threadId: ThreadId.make("t1") })).toBe("thread:t1");
    expect(webWorkOf({ threadId: null, taskId: TaskId.make("k1") })).toBe("task:k1");
    expect(webWorkOf({ threadId: null })).toBeNull();
  });

  it("reads a step's brief as written in your chat, and a deeper Task's in its parent's session", () => {
    const thread = ThreadId.make("t1");
    const root = TaskId.make("root");
    expect(briefWriterOf({ parentId: null, rootId: root, threadId: thread })).toBeNull();
    expect(briefWriterOf({ parentId: root, rootId: root, threadId: thread })).toEqual({ threadId: thread });
    expect(briefWriterOf({ parentId: TaskId.make("mid"), rootId: root, threadId: thread })).toEqual({
      threadId: null,
      taskId: "mid",
    });
  });
});

describe("web_fetch's page parts (ADR 036)", () => {
  it("cuts a long page at a line break near the size, and a page with none at the size", () => {
    const lines = Array.from({ length: 30 }, (_, at) => `line ${String(at).padStart(2, "0")}`).join("\n");
    const parts = pageParts(lines, 40);
    expect(parts.join("")).toBe(lines);
    expect(parts.every((part) => part.length <= 40)).toBe(true);
    expect(parts.slice(0, -1).every((part) => part.endsWith("\n"))).toBe(true);
    expect(pageParts("x".repeat(100), 40)).toEqual(["x".repeat(40), "x".repeat(40), "x".repeat(20)]);
    expect(pageParts("short", 40)).toEqual(["short"]);
  });

  it("tells the hob the page is outside data, where it came from, and which part comes next", () => {
    const page = {
      url: "https://example.com/b",
      title: "Lamps",
      contentType: "text/html",
      text: "x".repeat(150_000),
      links: [{ url: "https://example.com/oil", text: "Oil" }],
      bytes: 150_000,
      fetchedAt: "2026-11-08T00:00:00.000Z",
    };
    const first = pageAnswer(page, 1, ["https://example.com/a"]);
    expect(first).toContain("example.com");
    expect(first).toContain("Title: Lamps");
    expect(first).toContain("Redirected from: https://example.com/a");
    expect(first).toContain("Part 1 of 2. Read the next with web_fetch, the same url and part 2.");
    expect(first).toContain("1. Oil: https://example.com/oil");
    const last = pageAnswer(page, 2, []);
    expect(last).toContain("Part 2 of 2, the last.");
    expect(last).not.toContain("https://example.com/oil");
  });
});
