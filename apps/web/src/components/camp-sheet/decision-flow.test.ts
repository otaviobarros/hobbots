import { ChapterId, DECISION_TEXT_MAX, Decision, DecisionId, ChannelId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client.ts";
import {
  DECISION_FORM_CLOSED,
  type DecisionForm,
  type DecisionFormEvent,
  decisionFormStep,
  decisionProblem,
  recordDecisionError,
} from "./decision-flow.ts";

// Issue #1387 (ADR 037): recording a decision from the camp sheet, as one reducer (STD-REACT-029).

const old = new Decision({
  id: DecisionId.make("d1"),
  channelId: ChannelId.make("camp-1"),
  chapterId: ChapterId.make("c1"),
  sourceMessageId: null,
  text: "Ship on Fridays.",
  actor: { kind: "hob", id: "hob-1" },
  state: "active",
  supersededBy: null,
  recordedAt: "2026-11-12T00:00:00.000Z",
  supersededAt: null,
  revision: 1,
});

const run = (events: ReadonlyArray<DecisionFormEvent>, from: DecisionForm = DECISION_FORM_CLOSED) =>
  events.reduce(decisionFormStep, from);

describe("recording a decision", () => {
  it("shows the problem only once a send finds it, then saves the trimmed text under its key (#1387)", () => {
    const empty = run([
      { _tag: "Open", replaces: null },
      { _tag: "Send", key: "k1" },
    ]);
    expect(empty).toMatchObject({ step: "writing", shown: true });
    expect(decisionProblem("  ")).toBe("text-missing");
    expect(decisionProblem("x".repeat(DECISION_TEXT_MAX + 1))).toBe("text-long");
    const saving = run(
      [
        { _tag: "Edit", text: " Ship on Wednesdays. " },
        { _tag: "Send", key: "k2" },
      ],
      empty,
    );
    expect(saving).toMatchObject({ step: "saving", key: "k2", replaces: null });
    expect(run([{ _tag: "Saved" }], saving)).toEqual(DECISION_FORM_CLOSED);
  });

  it("keeps a change's text and key when it fails, and asks under a new key once edited (#1387)", () => {
    const failed = run([
      { _tag: "Open", replaces: old },
      { _tag: "Edit", text: "Ship on Wednesdays." },
      { _tag: "Send", key: "k1" },
      { _tag: "Failed", error: "unreachable" },
    ]);
    expect(failed).toMatchObject({ step: "failed", key: "k1", replaces: old, text: "Ship on Wednesdays." });
    expect(run([{ _tag: "Send", key: "k2" }], failed)).toMatchObject({ step: "saving", key: "k1" });
    const edited = run(
      [
        { _tag: "Edit", text: "Ship on Thursdays." },
        { _tag: "Send", key: "k3" },
      ],
      failed,
    );
    expect(edited).toMatchObject({ step: "saving", key: "k3", replaces: old });
    // Nothing closes or changes it while it saves.
    expect(run([{ _tag: "Close" }, { _tag: "Edit", text: "x" }], edited)).toBe(edited);
  });

  it("tells a refused change from one that got no answer (#1387)", () => {
    expect(recordDecisionError(new ApiError("", "DecisionChangeRefused"))).toBe("refused");
    expect(recordDecisionError(new TypeError("Failed to fetch"))).toBe("unreachable");
  });
});
