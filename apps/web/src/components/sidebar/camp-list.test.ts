import { describe, expect, it } from "vitest";
import { campList, foldedNews } from "./camp-list.ts";

const camps = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `c${index}` }));
const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((row) => row.id);

describe("campList", () => {
  it("shows every camp when there are few", () => {
    expect(campList(camps(5), undefined)).toEqual({ shown: camps(5), hidden: [] });
  });

  it("shows the first five and folds the rest", () => {
    const list = campList(camps(8), undefined);
    expect(ids(list.shown)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
    expect(ids(list.hidden)).toEqual(["c5", "c6", "c7"]);
  });

  it("keeps the open camp in its place even past the first five", () => {
    const list = campList(camps(8), "c6");
    expect(ids(list.shown)).toEqual(["c0", "c1", "c2", "c3", "c4", "c6"]);
    expect(ids(list.hidden)).toEqual(["c5", "c7"]);
  });
});

describe("foldedNews", () => {
  const camp = (unread: number, mentions: number) => ({ unread, place: { mentions } });

  it("counts the unread replies and the mentions of you in the folded camps (#1469)", () => {
    expect(foldedNews([])).toEqual({ unread: 0, mentions: 0 });
    expect(foldedNews([camp(2, 0), camp(1, 0)])).toEqual({ unread: 3, mentions: 0 });
    // A person's message that mentions you leaves no unread reply, and still counts.
    expect(foldedNews([camp(0, 1), camp(0, 0)])).toEqual({ unread: 0, mentions: 1 });
  });
});
