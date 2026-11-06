import { describe, expect, it } from "vitest";
import { isPackagedApp } from "./check-fuses.ts";

describe("isPackagedApp", () => {
  it("finds the macOS bundles electron-builder writes, not the helpers inside them", () => {
    expect(isPackagedApp("mac-arm64/Hobbots.app")).toBe(true);
    expect(isPackagedApp("mac/Hobbots.app")).toBe(true);
    expect(isPackagedApp("mac/Hobbots.app/Contents/Frameworks/Hobbots Helper.app")).toBe(false);
  });

  it("finds the executable of each Linux build, and nothing else in its folder", () => {
    expect(isPackagedApp("linux-unpacked/hobbots")).toBe(true);
    expect(isPackagedApp("linux-arm64-unpacked/hobbots")).toBe(true);
    expect(isPackagedApp("linux-unpacked/chrome-sandbox")).toBe(false);
    expect(isPackagedApp("linux-unpacked/resources/hobbots")).toBe(false);
    expect(isPackagedApp("Hobbots-1.0.0-amd64.deb")).toBe(false);
  });
});
