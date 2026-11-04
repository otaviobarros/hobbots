import { describe, expect, it } from "vitest";
import { isSidebarKey } from "./use-sidebar-open.ts";

const key = (mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>>, k = "\\") => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("isSidebarKey", () => {
  it("takes ⌘\\ and Ctrl+\\", () => {
    expect(isSidebarKey(key({ metaKey: true }))).toBe(true);
    expect(isSidebarKey(key({ ctrlKey: true }))).toBe(true);
  });

  it("ignores the key alone, with another modifier, or another key", () => {
    expect(isSidebarKey(key({}))).toBe(false);
    expect(isSidebarKey(key({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isSidebarKey(key({ metaKey: true, altKey: true }))).toBe(false);
    expect(isSidebarKey(key({ metaKey: true }, "k"))).toBe(false);
  });
});
