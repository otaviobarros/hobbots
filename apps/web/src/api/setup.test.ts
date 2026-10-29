import { InstallationSetup } from "@hobbots/domain";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { opensWelcome, readSetup, setupQuery, setupQueryKey } from "./setup.ts";

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

describe("readSetup", () => {
  // covers OP-001, DP-001
  it("[TC-OP-008] opens Home once another client has finished setup, despite this client's cached answer", async () => {
    // The hub's stored setup, shared by both clients.
    let stored = setup(false);
    const hub = { ...setupQuery, queryFn: async () => stored };
    const thisWindow = new QueryClient();
    const otherWindow = new QueryClient();

    expect(opensWelcome(await readSetup(thisWindow, hub))).toBe(true);
    // The other window finishes setup.
    stored = setup(true);
    otherWindow.setQueryData(setupQueryKey, stored);

    expect(opensWelcome(await readSetup(thisWindow, hub))).toBe(false);
  });

  it("falls back to the cached setup when the hub cannot be reached", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(setupQueryKey, setup(true));
    const unreachable = {
      ...setupQuery,
      queryFn: async (): Promise<InstallationSetup> => {
        throw new Error("offline");
      },
    };
    expect(await readSetup(client, unreachable)).toEqual(setup(true));
  });
});
