import { describe, expect, it } from "vitest";
import { textOf } from "../src/turn-activity.ts";

describe("textOf", () => {
  it("reads text only when it is valid UTF-8 with no NUL", () => {
    expect(textOf(new TextEncoder().encode("héllo\n"))).toBe("héllo\n");
    expect(textOf(new Uint8Array([0x68, 0x00, 0x69]))).toBeNull();
    expect(textOf(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull();
  });
});
