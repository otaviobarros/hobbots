import { describe, expect, it } from "vitest";
import type { KeyPress } from "../../lib/page-keys.ts";
import { decideKey } from "./use-decide-keys.ts";

const press = (key: string, fields: Partial<KeyPress> = {}): KeyPress => ({
  key,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  defaultPrevented: false,
  target: null,
  ...fields,
});

describe("decideKey", () => {
  it("reads A as allow once and D as deny, in either case", () => {
    expect(decideKey(press("a"))).toBe("allow");
    expect(decideKey(press("A"))).toBe("allow");
    expect(decideKey(press("d"))).toBe("deny");
    expect(decideKey(press("D"))).toBe("deny");
  });

  it("ignores other keys and ⌘A or Ctrl+A, which select text", () => {
    expect(decideKey(press("x"))).toBeUndefined();
    expect(decideKey(press("a", { metaKey: true }))).toBeUndefined();
    expect(decideKey(press("a", { ctrlKey: true }))).toBeUndefined();
  });
});
