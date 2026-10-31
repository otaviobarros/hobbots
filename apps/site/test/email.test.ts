import { describe, expect, it } from "vitest";
import { emailProblem } from "../src/scripts/email.ts";

describe("emailProblem", () => {
  it("accepts an address with a name, an @ and a domain", () => {
    expect(emailProblem("you@example.com")).toBe("");
    expect(emailProblem("first.last+hobs@mail.example.co")).toBe("");
  });

  it("asks for an address when the field is empty", () => {
    expect(emailProblem("")).toBe("Type your email address first.");
  });

  it("explains what is missing from an incomplete address", () => {
    for (const email of ["you", "you@", "you@example", "@example.com", "you @example.com"])
      expect(emailProblem(email)).toMatch(/^That email looks incomplete/);
  });
});
