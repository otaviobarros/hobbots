import { ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { doingOf, helloOf, isHobPageTab, startersOf, stateTag, statsLine } from "./hob-page-model.ts";

const plan = { id: ThreadId.make("t-plan"), title: "Plan the spring launch" };
const notes = { id: ThreadId.make("t-notes"), title: "Meeting notes" };

describe("stateTag", () => {
  it("gives each state one of the four families, with its glyph and word", () => {
    expect(stateTag("needs-you")).toEqual({ variant: "needs-you", glyph: "!", word: "Needs you" });
    expect(stateTag("thinking")).toEqual({ variant: "working", glyph: "●", word: "Working" });
    expect(stateTag("idle")).toEqual({ variant: "resting", glyph: "◷", word: "Resting" });
    expect(stateTag("paused")).toEqual({ variant: "resting", glyph: "◷", word: "Paused" });
    expect(stateTag("failed")).toEqual({ variant: "failed", glyph: "✗", word: "Had a problem" });
  });
});

describe("statsLine", () => {
  it("counts the chats and says since when the hob is around", () => {
    const hob = { createdAt: "2026-09-04T12:00:00.000Z" };
    expect(statsLine(hob, 0)).toMatch(/^No chats yet · with you since /);
    expect(statsLine(hob, 1)).toMatch(/^1 chat · /);
    expect(statsLine(hob, 12)).toMatch(/^12 chats · /);
  });
});

describe("doingOf", () => {
  it("puts needing you first, whatever the chats are doing", () => {
    expect(doingOf("needs-you", [plan], { [plan.id]: "working" })).toEqual({
      kind: "needs-you",
      text: "Waiting on you",
    });
  });

  it("names the chat the hob is writing in before one it is thinking about", () => {
    expect(doingOf("working", [notes, plan], { [notes.id]: "thinking", [plan.id]: "working" })).toEqual({
      kind: "live",
      text: "Writing “Plan the spring launch”",
    });
    expect(doingOf("thinking", [notes], { [notes.id]: "thinking" })).toEqual({
      kind: "live",
      text: "Thinking about “Meeting notes”",
    });
  });

  it("says a paused hob is paused and leaves a resting hob without a bubble", () => {
    expect(doingOf("paused", [plan], { [plan.id]: "working" })?.kind).toBe("quiet");
    expect(doingOf("idle", [plan], {})).toBeNull();
  });
});

describe("isHobPageTab", () => {
  it("takes only the page's tabs", () => {
    expect(isHobPageTab("history")).toBe(true);
    expect(isHobPageTab("chats")).toBe(true);
    expect(isHobPageTab("quests")).toBe(false);
    expect(isHobPageTab(undefined)).toBe(false);
  });
});

describe("a new hob", () => {
  it("rests as New until its first chat, and still says when it needs you", () => {
    expect(stateTag("idle", true)).toMatchObject({ variant: "done", word: "New" });
    expect(stateTag("idle", false).word).toBe("Resting");
    expect(stateTag("needs-you", true).word).toBe("Needs you");
  });

  it("says hello with its role's line, or plainly for a role in your own words", () => {
    expect(helloOf({ name: "Wren", role: "writer" })).toBe(
      "Hi! I'm Wren. Drafts emails, posts and documents with you. Where shall we start?",
    );
    expect(helloOf({ name: "Wren", role: null })).toBe("Hi! I'm Wren. Where shall we start?");
  });

  it("offers three starters: its own for an everyday helper, else its role family's", () => {
    expect(startersOf({ role: "writer" })[0]).toBe("Turn my bullet points into a friendly email");
    expect(startersOf({ role: "backend" })).toEqual(startersOf({ role: "frontend" }));
    expect(startersOf({ role: null })).toHaveLength(3);
  });
});
