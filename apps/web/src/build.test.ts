import { describe, expect, it } from "vitest";
import config from "../vite.config.ts";

describe("web build", () => {
  // covers DP-001
  it("[TC-DP-009] emits root-relative asset paths, so the server's fallback page loads on nested paths", () => {
    expect(config).toMatchObject({ base: "/" });
  });
});
