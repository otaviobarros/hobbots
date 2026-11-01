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
    retry: { firstRetryMs: 1, maxRetryMs: 4 },
  });
  return { hobs, seen, reads: () => reads, answers };
};

/** A read that answers `stale` this many times first. */
const after = (times: number, stale: ReadonlyArray<WorkingHob> | null, fresh: ReadonlyArray<WorkingHob>) => [
  ...Array.from({ length: times }, () => stale),
  fresh,
];

describe("which hobs are working", () => {
  // covers UX-001
  it("[TC-DP-046] reads again until the hub has registered a turn the event announced", async () => {
    const { hobs, seen, reads } = setup(after(2, [], [pip]));
    await hobs.changed("t1", true);
    expect(seen).toEqual([["Pip"]]);
    expect(reads()).toBe(3);
  });

  // covers UX-001
  it("[TC-DP-047] reads again until the hub has removed an ended turn, however long its cleanup takes", async () => {
    // More stale reads than the first version of this retry allowed, then one that did not answer.
    const { hobs, seen, reads } = setup([...after(8, [pip], []).slice(0, -1), null, []]);
    await hobs.changed("t1", false);
    expect(seen).toEqual([[]]);
    expect(reads()).toBe(10);
  });

  it("waits for a newer event that came during the reads, and shows no read that disagrees", async () => {
    let answer: ReadonlyArray<WorkingHob> = [pip];
    const seen: Array<ReadonlyArray<string>> = [];
    let reads = 0;
    const hobs = workingHobs({
      read: async () => {
        reads += 1;
        return answer;
      },
      onRead: (read) => void seen.push(read.map((hob) => hob.name)),
      retry: { firstRetryMs: 1, maxRetryMs: 4 },
    });
    await hobs.changed("t1", true);
    // The turn ends, and the hub removes it only after a few more reads.
    const ending = hobs.changed("t1", false);
    await expect.poll(() => reads).toBeGreaterThan(4);
    answer = [];
    await ending;
    expect(seen.at(-1)).toEqual([]);
    expect(seen.filter((names) => names.length > 0)).toEqual([["Pip"]]);
  });

  it("starts from a new snapshot on reset", async () => {
    const { hobs, seen, reads } = setup([[]]);
    void hobs.changed("t1", true);
    await expect.poll(() => reads()).toBeGreaterThan(1);
    await hobs.reset();
    expect(seen.at(-1)).toEqual([]);
  });
});
