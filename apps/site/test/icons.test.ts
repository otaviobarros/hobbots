import { describe, expect, it } from "vitest";
import { iconIco, iconSvg, touchIcon } from "../scripts/icons.ts";

describe("site icons", () => {
  it("draws the favicon on the app icon's 32-cell grid", () => {
    const svg = iconSvg();
    expect(svg).toContain('viewBox="0 0 32 32"');
    expect(svg).toContain('<rect width="32" height="32" fill="#141228"/>');
  });

  it("makes a 180 px Apple touch icon", () => {
    const png = touchIcon();
    expect(png.readUInt32BE(16)).toBe(180);
    expect(png.readUInt32BE(20)).toBe(180);
  });

  it("wraps one PNG for each size in the ICO", () => {
    const ico = iconIco([16, 32]);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(2);
    expect([ico.readUInt8(6), ico.readUInt8(22)]).toEqual([16, 32]);
    const offset = ico.readUInt32LE(6 + 12);
    expect(ico.subarray(offset, offset + 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});
