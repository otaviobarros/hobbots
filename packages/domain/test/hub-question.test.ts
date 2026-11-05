import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { RaiseHubQuestion, TaskToolInputs } from "../src/index.ts";

// Issue #976: the hub raises a question about a subject it names, never a Task, and its choices
// follow the same rules as a hob's (#740).

const decode = Schema.decodeUnknownExit(RaiseHubQuestion, { onExcessProperty: "error" });
const subject = { kind: "commit-identity", key: "default", title: "Commit identity" };
const github = { label: "My GitHub account", consequence: "Commits show as you on GitHub." };
const typed = { label: "A name and email I type", consequence: "" };
const refused = (input: unknown) => decode(input)._tag === "Failure";

describe("a question the hub raises", () => {
  it("needs a subject and takes no Task", () => {
    expect(refused({ subject, text: "Who should hobs commit as?" })).toBe(false);
    expect(refused({ text: "Who should hobs commit as?" })).toBe(true);
    expect(refused({ subject: { ...subject, kind: "Commit identity" }, text: "Who?" })).toBe(true);
    expect(refused({ subject, text: "Who?", task_id: "t1" })).toBe(true);
    expect(refused({ subject, text: "Who?", taskId: "t1" })).toBe(true);
  });

  it("offers two to four choices with unique labels, as a hob's question does", () => {
    const options = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ label: `Choice ${index + 1}`, consequence: "" }));
    expect(refused({ subject, text: "Who?", options: options(1) })).toBe(true);
    expect(refused({ subject, text: "Who?", options: options(2) })).toBe(false);
    expect(refused({ subject, text: "Who?", options: options(4) })).toBe(false);
    expect(refused({ subject, text: "Who?", options: options(5) })).toBe(true);
    expect(refused({ subject, text: "Who?", options: [github, { ...typed, label: "my github ACCOUNT" }] })).toBe(true);
    expect(refused({ subject, text: "Who?", options: [{ label: "", consequence: "" }, typed] })).toBe(true);
    // The same rules decide a hob's ask.
    const ask = Schema.decodeUnknownExit(TaskToolInputs.ask);
    expect(
      ask({ key: "k", task_id: "t", question: "Who?", options: [github, { ...typed, label: "my github ACCOUNT" }] })
        ._tag,
    ).toBe("Failure");
  });

  it("recommends one of its choices, counted from 0", () => {
    expect(refused({ subject, text: "Who?", options: [github, typed], recommended: 0 })).toBe(false);
    expect(refused({ subject, text: "Who?", options: [github, typed], recommended: 1 })).toBe(false);
    expect(refused({ subject, text: "Who?", options: [github, typed], recommended: 2 })).toBe(true);
    expect(refused({ subject, text: "Who?", options: [github, typed], recommended: -1 })).toBe(true);
    expect(refused({ subject, text: "Who?", recommended: 0 })).toBe(true);
  });
});
