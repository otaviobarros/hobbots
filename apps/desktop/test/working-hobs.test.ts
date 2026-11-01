import { describe, expect, it } from "vitest";
import { type WorkingHob, workingHobs } from "../src/main/working-hobs.ts";

const pip = { threadId: "t1", name: "Pip" };

/** Working hobs over a hub whose reads give `answers` in turn, then the last one again. */
const setup = (answers: Array<ReadonlyArray<WorkingHob> | null>) => {
  const seen: Array<ReadonlyArray<string>> = [];
  let reads = 0;
  const hobs = workingHobs({
    read: async () => answers[Math.min(reads++, answers.length - 1)] ?? null,
    onRead: (read) => void seen.push(read.map((hob) => hob.name)),
    retry: { firstRetryMs: 1, retries: 3 },
  });
  return { hobs, seen, reads: () => reads };
};

describe("which hobs are working", () => {
  // covers UX-001
  it("[TC-DP-046] reads again until the hub has registered a turn the event announced", async () => {
    const { hobs, seen, reads } = setup([[], [], [pip]]);
    await hobs.changed("t1", true);
    expect(seen).toEqual([["Pip"]]);
    expect(reads()).toBe(3);
  });

  // covers UX-001
  it("[TC-DP-047] reads again until the hub has removed a turn the event ended, and when a read did not answer", async () => {
    const { hobs, seen, reads } = setup([[pip], null, []]);
    await hobs.changed("t1", false);
    expect(seen).toEqual([[]]);
    expect(reads()).toBe(3);
  });

  it("lets the last read stand once the retries run out, and expects nothing of the next", async () => {
    const { hobs, seen, reads } = setup([[]]);
    await hobs.changed("t1", true);
    expect(seen).toEqual([[]]);
    expect(reads()).toBe(4);
    await hobs.refresh();
    expect(reads()).toBe(5);
  });
});
