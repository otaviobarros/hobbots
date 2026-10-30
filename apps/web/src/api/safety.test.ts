import { describe, expect, it } from "vitest";
import { addFolder, folderName, foldersShared, PRESETS, presetInfo, removeFolder } from "./safety.ts";

describe("safety presets", () => {
  it("offers Careful, Balanced and Trusting, with Balanced recommended and paying always off", () => {
    expect(PRESETS.map((p) => p.id)).toEqual(["careful", "balanced", "trusting"]);
    expect(PRESETS.filter((p) => p.recommended).map((p) => p.id)).toEqual(["balanced"]);
    for (const preset of PRESETS) expect(preset.rules).toContainEqual(["Pay for things", "Never"]);
    expect(presetInfo("trusting").label).toBe("Trusting");
  });
});

describe("folders", () => {
  it("names a folder by its last part", () => {
    expect(folderName("/Users/me/code")).toBe("code");
    expect(folderName("/Users/me/code/")).toBe("code");
    expect(folderName("/")).toBe("/");
  });

  it("adds a folder once and removes it", () => {
    const once = addFolder(["/a"], "/b");
    expect(addFolder(once, "/a")).toEqual(["/a", "/b"]);
    expect(removeFolder(once, "/a")).toEqual(["/b"]);
  });

  it("counts shared folders", () => {
    expect(foldersShared(0)).toBe("No folders shared");
    expect(foldersShared(1)).toBe("1 folder shared");
  });
});
