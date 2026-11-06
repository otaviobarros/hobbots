import type { HobPermissions } from "@hobbots/api";
import {
  type AgentId,
  Message,
  MessageId,
  type MessageStatus,
  PRESET_DECISIONS,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { enforcementFixture } from "../test/enforcement.ts";
import { queryKeys, showLastLine, storeSavedPermissions } from "./queries.ts";

const agentId = "pip" as AgentId;

const version = (configVersion: number): HobPermissions => ({
  agentId,
  configVersion,
  preset: "balanced",
  sharedFolders: [],
  policy: { ownFolders: [], hiddenSharedFolders: [], overrides: configVersion > 2 ? { "run-commands": "ask" } : {} },
  folders: [],
  decisions: PRESET_DECISIONS.balanced,
  enforcement: enforcementFixture(),
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

describe("showLastLine", () => {
  const threadId = ThreadId.make("chat");
  const reply = (content: string, quiet: boolean, status: MessageStatus = "complete") =>
    new Message({
      id: MessageId.make("reply"),
      threadId,
      role: "assistant",
      content,
      status,
      error: null,
      configVersion: null,
      createdAt: "2026-11-04T00:00:00.000Z",
      revision: 1,
      quiet,
    });
  const withLine = (lastLine: string) => [
    new Thread({
      id: threadId,
      agentId,
      title: "Black Friday",
      createdAt: "2026-11-04T00:00:00.000Z",
      updatedAt: "2026-11-04T00:00:00.000Z",
      lastLine,
    }),
  ];

  it("reads the list again when a reply it already shows as the last line completes quiet (#1006)", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.threads(agentId), withLine("Ada is building the page"));
    showLastLine(client, reply("Ada is building the page", false, "streaming"));
    expect(client.getQueryState(queryKeys.threads(agentId))?.isInvalidated).toBe(false);

    showLastLine(client, reply("Ada is building the page", true));

    expect(client.getQueryState(queryKeys.threads(agentId))?.isInvalidated).toBe(true);
  });

  it("shows a reply that is not quiet as the last line without reading again", () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.threads(agentId), withLine("The plan"));
    showLastLine(client, reply("Ada failed to deploy", false));
    expect(client.getQueryData<ReadonlyArray<Thread>>(queryKeys.threads(agentId))?.[0]?.lastLine).toBe(
      "Ada failed to deploy",
    );
    expect(client.getQueryState(queryKeys.threads(agentId))?.isInvalidated).toBe(false);
  });
});
