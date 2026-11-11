import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { byRule, decodeJudgment, HubDecider, type Judgment, judgmentText } from "../src/hub-decider.ts";

// The hub's judgments (ADR 037, issue #1367): a schema of choices in, a choice and a confidence out.

const drift: Judgment<"same" | "drifting"> = {
  task: "judgments",
  question: "Is the last chapter drifting into a topic of its own?",
  input: "The chapter's lines.",
  choices: Schema.Literals(["same", "drifting"]),
  rule: "same",
};

describe("HubDecider", () => {
  it("asks the question about the input in the prompt, with the answer's shape", () => {
    const text = judgmentText(drift);
    // All of it in the prompt, which a runtime never buries under its own system prompt.
    expect(text.prompt).toContain(drift.question);
    expect(text.prompt).toContain("<input>\nThe chapter's lines.\n</input>");
    expect(text.prompt).toContain('"drifting"');
    expect(text.prompt).toContain('"confidence"');
    expect(text.instructions).toContain("JSON");
  });

  it("decodes an answer in the judgment's shape, in a code fence or bare", () => {
    expect(decodeJudgment(drift, '{"choice":"drifting","confidence":0.8}')).toEqual(
      Option.some({ choice: "drifting", confidence: 0.8 }),
    );
    expect(decodeJudgment(drift, 'Here it is:\n```json\n{"choice": "same", "confidence": 1}\n```')).toEqual(
      Option.some({ choice: "same", confidence: 1 }),
    );
  });

  it("decodes nothing from an answer outside the choices, out of range or not JSON", () => {
    for (const reply of [
      '{"choice":"maybe","confidence":0.5}',
      '{"choice":"same","confidence":2}',
      '{"choice":"same"}',
      "drifting",
      "{not json}",
      "",
    ])
      expect(decodeJudgment(drift, reply)).toEqual(Option.none());
  });

  it("answers every judgment with its rule on a hub with no brain", async () => {
    const decided = await Effect.runPromise(
      Effect.flatMap(HubDecider, (decider) => decider.decide(drift)).pipe(Effect.provide(HubDecider.rules)),
    );
    expect(decided).toEqual(byRule(drift));
    expect(decided).toEqual({ choice: "same", confidence: 1, by: "rule" });
  });
});
