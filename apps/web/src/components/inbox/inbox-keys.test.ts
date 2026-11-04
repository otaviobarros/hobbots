import { ApprovalRequest } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import type { KeyPress } from "../../lib/page-keys.ts";
import { ADA, BUILD, CAMPAIGN, COPY, memberApproval, QUILL } from "../../test/quests.ts";
import { approvalEntry } from "./inbox-entries.ts";
import { shownOrder, stepFrom, stepKey } from "./inbox-keys.ts";

const press = (key: string, fields: Partial<KeyPress> = {}): KeyPress => ({
  key,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  defaultPrevented: false,
  target: null,
  ...fields,
});

const risky = approvalEntry(
  new ApprovalRequest({ ...memberApproval(BUILD, ADA), onceOnly: true, expiresAt: "2026-11-01T15:00:00.000Z" }),
);
const soon = approvalEntry(
  new ApprovalRequest({ ...memberApproval(COPY, QUILL), expiresAt: "2026-11-01T10:20:00.000Z" }),
);
const later = approvalEntry(
  new ApprovalRequest({ ...memberApproval(CAMPAIGN, ADA), expiresAt: "2026-11-01T12:00:00.000Z" }),
);
const order = [risky, soon, later];

describe("stepKey", () => {
  it("moves up with ↑ or K and down with ↓ or J", () => {
    expect(["ArrowUp", "k", "K"].map((key) => stepKey(press(key)))).toEqual(["previous", "previous", "previous"]);
    expect(["ArrowDown", "j", "J"].map((key) => stepKey(press(key)))).toEqual(["next", "next", "next"]);
  });

  it("leaves ⌥↑ and ⌥↓ to the chat list, and other keys alone", () => {
    expect(stepKey(press("ArrowDown", { altKey: true }))).toBeUndefined();
    expect(stepKey(press("a"))).toBeUndefined();
  });
});

describe("stepFrom", () => {
  it("steps to the entry below or above, and holds at either end", () => {
    expect(stepFrom(order, soon.key, "next")).toBe(later);
    expect(stepFrom(order, soon.key, "previous")).toBe(risky);
    expect(stepFrom(order, later.key, "next")).toBe(later);
    expect(stepFrom(order, risky.key, "previous")).toBe(risky);
  });

  it("starts at the first entry when none in the list is selected, and finds nothing in an empty list", () => {
    expect(stepFrom(order, undefined, "next")).toBe(risky);
    expect(stepFrom(order, "gone", "previous")).toBe(risky);
    expect(stepFrom([], undefined, "next")).toBeUndefined();
  });
});

describe("shownOrder", () => {
  it("follows the list: by urgency as one list, by quest group after group", () => {
    expect(shownOrder([later, soon, risky], "urgency", () => undefined)).toEqual([risky, soon, later]);
    // Outside a quest the three share one thread, so they make one group, most urgent first.
    expect(shownOrder([later, soon, risky], "quest", () => undefined)).toEqual([risky, soon, later]);
  });
});
