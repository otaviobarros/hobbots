import { PRESET_DECISIONS, presetDecision, type SafetyPreset } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { GITHUB_CHARM } from "../src/github-operations.ts";

describe("the GitHub Charm's declaration", () => {
  // covers PE-001
  it("[TC-GEN-404] answers each GitHub operation as ADR 020's table does, under its new id", () => {
    // ADR 020's rows for Read GitHub, Open pull requests and Comment on GitHub, written out so a change shows.
    const table = {
      "github.read": ["allow", "allow", "allow"],
      "github.open-pull-request": ["ask", "ask", "allow"],
      "github.comment": ["ask", "ask", "allow"],
    } as const;
    const presets: ReadonlyArray<SafetyPreset> = ["careful", "balanced", "trusting"];
    for (const [operation, answers] of Object.entries(table)) {
      expect(
        presets.map((preset) => presetDecision(preset, operation as keyof typeof table, GITHUB_CHARM.operations)),
      ).toEqual(answers);
    }
    // Push stays a built-in operation with ADR 014's answers; the Charm only takes it over as its identity.
    expect(GITHUB_CHARM.takesOver).toEqual(["push"]);
    expect(presets.map((preset) => PRESET_DECISIONS[preset].push)).toEqual(["ask", "ask", "allow"]);
    // Every operation is the Charm's own, by its id.
    expect(GITHUB_CHARM.operations.every((operation) => operation.id.startsWith("github."))).toBe(true);
  });
});
