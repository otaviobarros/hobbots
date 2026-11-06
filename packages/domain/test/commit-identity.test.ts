import { describe, expect, it } from "vitest";
import { githubUserCommitIdentity, parseCommitIdentity } from "../src/index.ts";

// Issue #741: the identity a hob on the user's account commits as when their Git config sets none.

describe("A commit identity the user gives the hub", () => {
  it("reads a name and email written as Git writes them", () => {
    expect(parseCommitIdentity("Ada Lovelace <ada@example.com>")).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    expect(parseCommitIdentity("  Ada <ada@example.com>. ")).toEqual({ name: "Ada", email: "ada@example.com" });
  });

  it("finds none in words without both, or with an email that is not one", () => {
    for (const answer of ["done", "ada@example.com", "<ada@example.com>", "Ada <ada>", "Ada <a@b@c>", "Ada <a b@c>"]) {
      expect(parseCommitIdentity(answer), answer).toBeNull();
    }
  });

  it("commits as a GitHub account under its name, or login, at the noreply address GitHub links to it", () => {
    expect(githubUserCommitIdentity({ login: "otaviobarros", id: 35647586, name: null })).toEqual({
      name: "otaviobarros",
      email: "35647586+otaviobarros@users.noreply.github.com",
    });
    expect(githubUserCommitIdentity({ login: "ada", id: 1, name: "Ada Lovelace" }).name).toBe("Ada Lovelace");
  });
});
