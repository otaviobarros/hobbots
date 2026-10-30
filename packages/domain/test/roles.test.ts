import { describe, expect, it } from "vitest";
import {
  PICKER_FIRST,
  ROLE_FAMILIES,
  RoleHat,
  RoleTool,
  roleFields,
  STARTER_ROLES,
  starterRole,
} from "../src/index.ts";

describe("starter roles", () => {
  it("ships 54 roles with unique ids and titles, within the cap of 60", () => {
    expect(STARTER_ROLES).toHaveLength(54);
    expect(new Set(STARTER_ROLES.map((role) => role.id)).size).toBe(54);
    expect(new Set(STARTER_ROLES.map((role) => role.title.toLowerCase())).size).toBe(54);
  });

  it("draws every sigil on a 10 × 10 grid of moonlight, amber and plate", () => {
    for (const role of STARTER_ROLES) {
      expect(role.sigil, role.id).toHaveLength(10);
      for (const row of role.sigil) expect(row, role.id).toMatch(/^[#o.]{10}$/);
    }
  });

  it("puts every role in one of the seven families, each with roles", () => {
    expect(ROLE_FAMILIES.map((family) => family.id)).toEqual([
      "helpers",
      "leadership",
      "software",
      "business",
      "learning",
      "creative",
      "life",
    ]);
    for (const family of ROLE_FAMILIES) expect(STARTER_ROLES.some((role) => role.family === family.id)).toBe(true);
  });

  it("dresses every role in a known hat and tool", () => {
    for (const role of STARTER_ROLES) {
      expect(RoleHat.literals).toContain(role.hat);
      expect(RoleTool.literals).toContain(role.tool);
    }
  });

  it("shows the eight first roles in the picker's order", () => {
    expect(PICKER_FIRST.map((id) => starterRole(id).title)).toEqual([
      "Assistant",
      "Researcher",
      "Writer",
      "Software engineer",
      "Executive assistant",
      "Data analyst",
      "Tutor",
      "Life organizer",
    ]);
  });

  it("gives a hob taking a starter role its title, sigil, hat and tool", () => {
    expect(roleFields("frontend")).toEqual({
      role: "frontend",
      roleTitle: "Frontend engineer",
      sigil: "frontend",
      hat: "beanie",
      tool: "wand",
    });
  });
});
