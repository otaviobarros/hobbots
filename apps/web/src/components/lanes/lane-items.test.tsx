import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HobLookup } from "../quest/use-work.ts";
import { LaneItemRow } from "./lane-items.tsx";
import type { LaneItem } from "./lane-model.ts";

const hobs = (() => {
  throw new Error("A running lane's line names no hob");
}) as unknown as HobLookup;

const now = (since: string, label: string | null = "Waiting on pnpm dev"): LaneItem => ({
  kind: "now",
  key: "now-build",
  label,
  plain: null,
  since,
});

/** The text a row shows, with its tags taken out. */
const text = (item: LaneItem) => renderToStaticMarkup(<LaneItemRow item={item} hobs={hobs} />).replace(/<[^>]+>/g, "");

describe("a running lane's line", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-05T12:10:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("[TC-UX-1004-02] says when the hob last did something once it has gone quiet for a minute", () => {
    // covers UX-004: a Running hob that waits or is stuck reads differently from one that just moved (#1004)
    expect(text(now("2026-11-05T12:09:30.000Z"))).toBe("Waiting on pnpm dev");
    expect(text(now("2026-11-05T12:06:00.000Z"))).toBe("Waiting on pnpm dev· last step 4 minutes ago");
    expect(text(now("2026-11-05T11:54:00.000Z", null))).toBe("Working· last step 16 minutes ago");
  });
});
