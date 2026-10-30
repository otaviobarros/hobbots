import { InstallationSetup } from "@hobbots/domain";
import { focusManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { opensWelcome, readSetup, setupDone, setupQuery, setupQueryKey, watchedSetupQuery } from "./setup.ts";

const setup = (completed: boolean) =>
  new InstallationSetup({ completed, safetyPreset: "balanced", approvedFolders: [], connectedProviders: [] });

describe("opening the app", () => {
  it("shows Welcome until setup is done, then Home", () => {
    expect(opensWelcome(setup(false))).toBe(true);
    expect(opensWelcome(setup(true))).toBe(false);
  });

  it("shows Home when the setup cannot be read", () => {
    expect(opensWelcome(undefined)).toBe(false);
  });

  // covers OP-001
  it("[TC-OP-009] keeps Welcome and the setup steps open until setup is done, then hands over to Home", () => {
    expect(setupDone(setup(false))).toBe(false);
    expect(setupDone(undefined)).toBe(false);
    expect(setupDone(setup(true))).toBe(true);
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

describe("watchedSetupQuery", () => {
  afterEach(() => focusManager.setFocused(undefined));

  const providers = (connectedProviders: InstallationSetup["connectedProviders"]) =>
    new InstallationSetup({ completed: false, safetyPreset: "balanced", approvedFolders: [], connectedProviders });

  // covers OP-001, DP-001
  it("[TC-OP-013] shows a provider another client connected or disconnected once this window is back", async () => {
    // The hub's stored setup, changed by another client while this window is in the background.
    let stored = providers(["claude-code"]);
    // The app's defaults: no refetch on focus, data fresh for 30 seconds.
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } } });
    const observer = new QueryObserver(client, {
      ...watchedSetupQuery,
      queryFn: async () => stored,
      refetchInterval: false,
    });
    // Mounted as QueryClientProvider mounts it, so it follows window focus.
    client.mount();
    const unsubscribe = observer.subscribe(() => {});
    const connected = () => observer.getCurrentResult().data?.connectedProviders;
    const comeBack = () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    };

    await vi.waitFor(() => expect(connected()).toEqual(["claude-code"]));
    stored = providers([]);
    comeBack();
    await vi.waitFor(() => expect(connected()).toEqual([]));
    stored = providers(["claude-code"]);
    comeBack();
    await vi.waitFor(() => expect(connected()).toEqual(["claude-code"]));
    unsubscribe();
    client.unmount();
  });

  it("checks the hub again every few seconds while the screen is open", () =>
    expect(watchedSetupQuery.refetchInterval).toBe(3000));
});
