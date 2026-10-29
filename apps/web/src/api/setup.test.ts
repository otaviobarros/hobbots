import { InstallationSetup } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { opensWelcome } from "./setup.ts";

const setup = (completed: boolean) =>
  new InstallationSetup({ completed, safetyPreset: "balanced", approvedFolders: [] });

describe("opening the app", () => {
  it("shows Welcome until setup is done, then Home", () => {
    expect(opensWelcome(setup(false))).toBe(true);
    expect(opensWelcome(setup(true))).toBe(false);
  });

  it("shows Home when the setup cannot be read", () => {
    expect(opensWelcome(undefined)).toBe(false);
  });
});
