import { describe, expect, it } from "vitest";
import { memoryEngineDir } from "../src/main/memory-engine.ts";

describe("the memory engine's folder", () => {
  it("is in the resources of a packaged app, and in the memory package of a checkout", () => {
    expect(memoryEngineDir({ resourcesPath: "/Applications/Hobbots.app/Contents/Resources" }, "/ignored")).toBe(
      "/Applications/Hobbots.app/Contents/Resources/memory",
    );
    expect(memoryEngineDir(null, "/src/hobbots/apps/desktop/out/main", "darwin", "arm64")).toBe(
      "/src/hobbots/packages/memory/engine/darwin-arm64",
    );
  });
});
