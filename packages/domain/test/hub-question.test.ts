import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { HubQuestion, RaiseHubQuestion, TaskToolInputs } from "../src/index.ts";

// Issue #976: the hub raises a question about a thing it names, never a Task, and its choices
// follow the same rules as a hob's (#740). Issue #1045: it carries codes and data, never sentences,
// and its choices are stable keys its kind offers.

const decode = Schema.decodeUnknownExit(RaiseHubQuestion, { onExcessProperty: "error" });
const github = {
  login: "otaviobarros",
  identity: { name: "Otavio", email: "1+otaviobarros@users.noreply.github.com" },
};
const ask = { kind: "commit-identity", reason: "no-git-identity", github, unread: null };
const backups = { kind: "fake-check", check: "backups", applied: null };
const refused = (input: unknown) => decode(input)._tag === "Failure";

describe("a question the hub raises", () => {
  it("needs a key and an ask of a known kind, and takes no Task and no text", () => {
    expect(refused({ key: "user", ask })).toBe(false);
    expect(refused({ ask })).toBe(true);
    expect(refused({ key: "user", ask: { ...ask, kind: "Commit identity" } })).toBe(true);
    expect(refused({ key: "user", ask: { ...ask, reason: "Your Git config sets no name" } })).toBe(true);
    expect(refused({ key: "user", ask, text: "Who should hobs commit as?" })).toBe(true);
    expect(refused({ key: "user", ask, task_id: "t1" })).toBe(true);
    expect(refused({ key: "user", ask, taskId: "t1" })).toBe(true);
  });

  it("offers two to four choices its kind knows, each once, by key", () => {
    expect(refused({ key: "user", ask, options: ["github"] })).toBe(true);
    expect(refused({ key: "user", ask, options: ["github", "own-git"] })).toBe(false);
    expect(refused({ key: "user", ask, options: ["github", "github"] })).toBe(true);
    expect(refused({ key: "user", ask, options: ["github", "nightly"] })).toBe(true);
    expect(refused({ key: "user", ask, options: ["My GitHub account", "own-git"] })).toBe(true);
    expect(refused({ key: "backups", ask: backups, options: ["nightly", "weekly"] })).toBe(false);
    expect(refused({ key: "backups", ask: backups, options: ["github", "own-git"] })).toBe(true);
    // The GitHub choice needs the account it commits as.
    expect(refused({ key: "user", ask: { ...ask, github: null }, options: ["github", "own-git"] })).toBe(true);
    // A hob's ask keeps its labels and the same two-to-four rule.
    const hobAsk = Schema.decodeUnknownExit(TaskToolInputs.ask);
    const labelled = [
      { label: "Light", consequence: "" },
      { label: "light", consequence: "" },
    ];
    expect(hobAsk({ key: "k", task_id: "t", question: "Which?", options: labelled })._tag).toBe("Failure");
  });

  it("recommends one of its choices by key", () => {
    expect(refused({ key: "user", ask, options: ["github", "own-git"], recommended: "github" })).toBe(false);
    expect(refused({ key: "user", ask, options: ["github", "own-git"], recommended: "own-git" })).toBe(false);
    expect(refused({ key: "user", ask, options: ["github", "own-git"], recommended: "nightly" })).toBe(true);
    expect(refused({ key: "user", ask, options: ["github", "own-git"], recommended: 0 })).toBe(true);
    expect(refused({ key: "user", ask, recommended: "github" })).toBe(true);
  });

  it("is read back with its ask, its choices' keys and the key you picked", () => {
    const stored = {
      id: "q1",
      key: "user",
      chat: null,
      ask,
      options: ["github", "own-git"],
      recommended: "github",
      state: "answered",
      answer: null,
      picked: "github",
      createdAt: "2026-11-08T10:00:00.000Z",
      answeredAt: "2026-11-08T10:01:00.000Z",
      answeredByDeviceId: "window",
      answeredVia: "inbox",
      revision: 3,
    };
    const read = Schema.decodeUnknownSync(HubQuestion)(stored);
    expect(read.ask).toEqual(ask);
    expect(read.picked).toBe("github");
  });
});
