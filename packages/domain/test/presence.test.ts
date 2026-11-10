import { describe, expect, it } from "vitest";
import type { MessageStatus, ReplyStep } from "../src/message.ts";
import { hobPresenceState, replyActivity } from "../src/presence.ts";

// A command the reply waits on once it has answered (#1056).
const waitedCommand: ReplyStep = {
  id: "c1",
  kind: "tool",
  label: "Running pnpm test",
  state: "running",
  waitedOn: true,
};

const reply = (status: MessageStatus, content: string, steps: ReadonlyArray<ReplyStep> = []) => ({
  status,
  content,
  steps,
});

describe("replyActivity", () => {
  it("thinks before the first words", () => expect(replyActivity(reply("streaming", ""))).toBe("thinking"));
  it("works once it writes, stopping included", () => {
    expect(replyActivity(reply("streaming", "Hel"))).toBe("working");
    expect(replyActivity(reply("stopping", "Hel"))).toBe("working");
  });
  it("waits once it only waits on commands it started", () =>
    expect(replyActivity(reply("streaming", "Done, tests run", [waitedCommand]))).toBe("waiting"));
  it("does nothing once it ended", () => expect(replyActivity(reply("complete", "Hello"))).toBeNull());
});

describe("hobPresenceState", () => {
  const active = { status: "active", needsYou: false, replies: [] } as const;

  it("puts its lifecycle first", () =>
    expect(hobPresenceState({ ...active, status: "paused", needsYou: true, replies: ["working"] })).toBe("paused"));
  it("needs you over what its replies do", () =>
    expect(hobPresenceState({ ...active, needsYou: true, replies: ["working"] })).toBe("needs-you"));
  it("works, then thinks, then waits on a command", () => {
    expect(hobPresenceState({ ...active, replies: ["waiting", "thinking", "working"] })).toBe("working");
    expect(hobPresenceState({ ...active, replies: ["waiting", "thinking"] })).toBe("thinking");
    expect(hobPresenceState({ ...active, replies: ["waiting"] })).toBe("on-command");
  });
  it("rests with nothing running", () => expect(hobPresenceState(active)).toBe("idle"));
});
