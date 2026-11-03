import { describe, expect, it } from "vitest";
import { versionLabel } from "./messages.ts";

describe("versionLabel", () => {
  it("names a release and calls a checkout a development build", () => {
    expect(versionLabel("0.4.0")).toBe("Hobbots 0.4.0");
    expect(versionLabel("development")).toBe("Development build");
  });
});
