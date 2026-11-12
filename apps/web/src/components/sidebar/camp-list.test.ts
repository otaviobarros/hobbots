import { describe, expect, it } from "vitest";
import { campList } from "./camp-list.ts";

const camps = (count: number, unread: ReadonlyArray<number> = []) =>
  Array.from({ length: count }, (_, index) => ({ id: `c${index}`, unread: unread.includes(index) }));
const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((row) => row.id);

describe("campList", () => {
  it("shows every camp when there are few", () => {
    expect(campList(camps(5), undefined)).toEqual({ shown: camps(5), hidden: 0, hiddenUnread: false });
  });

  it("shows the first five and counts the rest", () => {
    const list = campList(camps(8), undefined);
    expect(ids(list.shown)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
    expect(list.hidden).toBe(3);
    expect(list.hiddenUnread).toBe(false);
  });

  it("keeps the open camp in its place even past the first five", () => {
    const list = campList(camps(8), "c6");
    expect(ids(list.shown)).toEqual(["c0", "c1", "c2", "c3", "c4", "c6"]);
    expect(list.hidden).toBe(2);
  });

  it("says when a hidden camp has messages you have not read", () => {
    expect(campList(camps(8, [7]), undefined).hiddenUnread).toBe(true);
    expect(campList(camps(8, [2]), undefined).hiddenUnread).toBe(false);
    // The open camp shows, so its unread dot is on its own row, not on Show more.
    expect(campList(camps(8, [7]), "c7").hiddenUnread).toBe(false);
  });
});
