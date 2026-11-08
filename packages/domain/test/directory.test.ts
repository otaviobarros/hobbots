import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Agent, AgentId, type AgentStatus, findInDirectory, listedForHob } from "../src/index.ts";

const hob = (id: string, name: string, status: AgentStatus = "active", visibleToHobs = true) => ({
  id: AgentId.make(`id-${id}`),
  name,
  status,
  visibleToHobs,
});

const hub = [
  hob("ada", "Ada"),
  hob("pip", "Pip"),
  hob("quill", "Quill", "paused"),
  hob("rook", "Rook", "retired"),
  hob("wren", "Wren", "active", false),
  hob("pip-2", " pip "),
];

describe("hob directory", () => {
  it("lists every other hob, paused ones included, and leaves out the reader, retired and hidden hobs", () => {
    expect(listedForHob(hub, AgentId.make("id-ada")).map((h) => h.id)).toEqual(["id-pip", "id-quill", "id-pip-2"]);
  });

  it("lets a hidden hob still see the others", () => {
    expect(listedForHob(hub, AgentId.make("id-wren")).map((h) => h.id)).toEqual([
      "id-ada",
      "id-pip",
      "id-quill",
      "id-pip-2",
    ]);
  });

  it("finds a hob by id, then by name ignoring case and spaces, every hob of a shared name", () => {
    const ada = AgentId.make("id-ada");
    expect(findInDirectory(hub, ada, "pip").map((h) => h.id)).toEqual(["id-pip", "id-pip-2"]);
    expect(findInDirectory(hub, ada, "  PIP ").map((h) => h.id)).toEqual(["id-pip", "id-pip-2"]);
    expect(findInDirectory(hub, ada, "id-pip-2").map((h) => h.id)).toEqual(["id-pip-2"]);
  });

  it("treats a hidden, retired or unknown hob alike, by name or id", () => {
    const ada = AgentId.make("id-ada");
    for (const named of ["Wren", "id-wren", "Rook", "id-rook", "Nobody"])
      expect(findInDirectory(hub, ada, named)).toEqual([]);
  });

  it("lets a hob find itself while it is hidden", () => {
    expect(findInDirectory(hub, AgentId.make("id-wren"), "Wren").map((h) => h.id)).toEqual(["id-wren"]);
  });

  it("decodes a hob saved before the switch as visible", () => {
    const decoded = Schema.decodeUnknownSync(Agent)({
      id: "pip",
      name: "Pip",
      role: null,
      roleTitle: "Writer",
      sigil: "writer",
      hat: null,
      tool: null,
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 1,
      lookColor: "moss",
      status: "active",
      retiredAt: null,
      configVersion: 1,
      createdAt: "2026-11-08T00:00:00.000Z",
      revision: 1,
    });
    expect(decoded.visibleToHobs).toBe(true);
  });
});
