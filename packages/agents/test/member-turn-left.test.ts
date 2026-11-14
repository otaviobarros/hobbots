import { Agent, AgentId, OWNER_ACTOR } from "@hobbots/domain";
import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { memberTurnLeft } from "../src/thread-runner.ts";

const at = (iso: string) => Date.parse(iso);
const launched = at("2026-11-14T10:00:00.000Z");

const pip = (fields: Partial<Agent> = {}) =>
  Option.some(
    new Agent({
      id: AgentId.make("pip"),
      name: "Pip",
      roleTitle: "Scout",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 1,
      lookColor: "moss",
      configVersion: 1,
      createdAt: "2026-11-01T00:00:00.000Z",
      ...fields,
    }),
  );

describe("a member hob's turn registered in a camp", () => {
  // covers AG-006, ADR 039 (One hob speaks at a time)
  it("[TC-CH-1461-22] stops only when the hob is gone or its running work was stopped", () => {
    // Paused, or retired letting running replies finish: nothing stopped its work, so it finishes.
    expect(memberTurnLeft(pip({ status: "paused" }), null, launched)).toBe(false);
    expect(memberTurnLeft(pip({ status: "retired", retiredAt: "2026-11-14T10:00:01.000Z" }), null, launched)).toBe(
      false,
    );
    // Finishing its open Tasks before it retires.
    expect(
      memberTurnLeft(pip({ retiring: { since: "2026-11-14T09:59:00.000Z", by: OWNER_ACTOR } }), null, launched),
    ).toBe(false);
    // A stop from before the hob came back, with the turn launched after it.
    expect(memberTurnLeft(pip(), at("2026-11-14T09:00:00.000Z"), launched)).toBe(false);

    // Gone, stopped since the turn launched, or retired with its work stopped before the turn launched.
    expect(memberTurnLeft(Option.none(), null, launched)).toBe(true);
    expect(memberTurnLeft(pip(), at("2026-11-14T10:00:00.500Z"), launched)).toBe(true);
    expect(
      memberTurnLeft(
        pip({ status: "retired", retiredAt: "2026-11-14T09:59:59.000Z" }),
        at("2026-11-14T09:59:59.000Z"),
        launched,
      ),
    ).toBe(true);
  });
});
