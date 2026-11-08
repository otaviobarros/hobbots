import { hobCard, renderRoster } from "@hobbots/agents";
import { Agent, AgentId, roleFields } from "@hobbots/domain";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { fakeRosterPrompt, makeFakeRuntime } from "../src/fake.ts";

const pip = hobCard(
  new Agent({
    id: AgentId.make("pip"),
    name: "Pip",
    ...roleFields("writer"),
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: "2026-11-08T00:00:00.000Z",
  }),
  [],
);
const roster = renderRoster([pip], new Set(), true) ?? "";

const reply = (prompt: string, briefing?: string) =>
  makeFakeRuntime()
    .sendPrompt({
      prompt,
      sessionId: null,
      instructions: "",
      instructionsChanged: false,
      model: null,
      effort: null,
      ...(briefing !== undefined && { briefing }),
    })
    .pipe(Stream.runCollect, Effect.runPromise)
    .then((events) => Array.from(events).flatMap((event) => (event._tag === "Completed" ? [event.text] : [])));

describe("the fake runtime's roster", () => {
  // covers ADR 032 (Every runtime)
  it("[TC-RT-1234-01] is left out of its echo and given back when asked", async () => {
    expect(await reply("Hello", `${roster}\n\nYour Task.`)).toEqual(["Echo: Your Task.\n\nHello"]);
    expect(await reply("Hello", roster)).toEqual(["Echo: Hello"]);
    expect(await reply(fakeRosterPrompt, `${roster}\n\nYour Task.`)).toEqual([roster]);
    expect(await reply(fakeRosterPrompt)).toEqual(["No roster."]);
  });
});
