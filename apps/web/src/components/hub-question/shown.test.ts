import { HubQuestion, HubQuestionId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { shownHubQuestion } from "./shown.ts";

// Issue #1045: the hub sends a question as a kind, codes and choice keys; the web app words it.

const question = (fields: Pick<HubQuestion, "key" | "ask" | "options" | "recommended" | "picked">) =>
  new HubQuestion({
    id: HubQuestionId.make("h1"),
    chat: null,
    state: "open",
    answer: null,
    createdAt: "2026-11-08T10:00:00.000Z",
    answeredAt: null,
    answeredByDeviceId: null,
    answeredVia: null,
    revision: 1,
    ...fields,
  });

const github = { login: "ada", identity: { name: "Ada", email: "1+ada@users.noreply.github.com" } };

describe("shownHubQuestion", () => {
  it("words who hobs commit as, with the GitHub account it offers recommended", () => {
    const shown = shownHubQuestion(
      question({
        key: "user",
        ask: { kind: "commit-identity", reason: "no-git-identity", github, unread: null },
        options: ["github", "own-git"],
        recommended: "github",
        picked: "own-git",
      }),
    );
    expect(shown.title).toBe("Who hobs commit as");
    expect(shown.text).toContain("Your Git config sets no name and email");
    expect(shown.text).toContain("Pick one, or type a name and email");
    expect(shown.options.map((option) => option.label)).toEqual([
      "My GitHub account, @ada",
      "I'll set it in Git myself",
    ]);
    expect(shown.options[0]?.consequence).toBe(
      "Commits are made as Ada <1+ada@users.noreply.github.com>, which GitHub links to your account.",
    );
    expect(shown).toMatchObject({ recommended: 0, picked: 1 });
  });

  it("says which answer it could not read, and asks to type one when no GitHub account is offered", () => {
    const shown = shownHubQuestion(
      question({
        key: "user",
        ask: { kind: "commit-identity", reason: "unreadable-answer", github: null, unread: "whatever" },
        options: [],
        recommended: null,
        picked: null,
      }),
    );
    expect(shown.text).toMatch(
      /^Hobbots couldn't find a name and email in "whatever"\. Who should hobs commit as\? Type/,
    );
    expect(shown).toMatchObject({ options: [], recommended: null, picked: null });
  });

  it("words the made-up questions, and what the hub applied from a choice or from words", () => {
    const backups = shownHubQuestion(
      question({
        key: "backups",
        ask: { kind: "fake-check", check: "backups", applied: null },
        options: ["nightly", "weekly"],
        recommended: "nightly",
        picked: null,
      }),
    );
    expect(backups.title).toBe("Nightly backups");
    expect(backups.options.map((option) => option.label)).toEqual(["Every night", "Every week"]);
    const applied = (picked: "nightly" | null, answer: string | null) =>
      shownHubQuestion(
        question({
          key: "applied",
          ask: { kind: "fake-check", check: "applied", applied: { picked, answer } },
          options: [],
          recommended: null,
          picked: null,
        }),
      ).text;
    expect(applied("nightly", null)).toBe("The hub applied: Every night");
    expect(applied(null, "Kitchen Mac")).toBe("The hub applied: Kitchen Mac");
  });
});
