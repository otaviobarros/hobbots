import type { HobPermissions } from "@hobbots/api";
import { type AgentId, PRESET_DECISIONS } from "@hobbots/domain";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { queryKeys, storeSavedPermissions } from "./queries.ts";

const agentId = "pip" as AgentId;

const version = (configVersion: number): HobPermissions => ({
  agentId,
  configVersion,
  preset: "balanced",
  sharedFolders: [],
  policy: { ownFolders: [], hiddenSharedFolders: [], overrides: configVersion > 2 ? { "run-commands": "ask" } : {} },
  folders: [],
  decisions: PRESET_DECISIONS.balanced,
});

// The profile keys its read on the hob's version and the setup, as `permissionsQuery` does.
const keyFor = (configVersion: number) => [...queryKeys.permissions(agentId), configVersion, "balanced"];

describe("storeSavedPermissions", () => {
  // covers PE-002
  it("[TC-PE-032] keeps a newer version another window saved when this window's older answer arrives late", async () => {
    const client = new QueryClient();
    // This window saved version 2, but the other window's version 3 was read first.
    client.setQueryData(keyFor(2), version(1));
    client.setQueryData(keyFor(3), version(3));

    await storeSavedPermissions(client, agentId, version(2));

    expect(client.getQueryData<HobPermissions>(keyFor(3))?.configVersion).toBe(3);
    expect(client.getQueryData<HobPermissions>(keyFor(2))?.configVersion).toBe(2);
  });

  it("cancels a read still on its way, so its older answer cannot land after the saved one", async () => {
    const client = new QueryClient();
    client.setQueryData(keyFor(1), version(1));
    let answer: (permissions: HobPermissions) => void = () => {};
    const read = client
      .fetchQuery({ queryKey: keyFor(1), queryFn: () => new Promise<HobPermissions>((resolve) => (answer = resolve)) })
      .catch(() => undefined);

    await storeSavedPermissions(client, agentId, version(2));
    answer(version(1));
    await read;

    expect(client.getQueryData<HobPermissions>(keyFor(1))?.configVersion).toBe(2);
  });
});
