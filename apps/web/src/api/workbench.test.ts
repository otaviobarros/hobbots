import type { AttemptActivityRead } from "@hobbots/api";
import { AttemptActivity } from "@hobbots/domain";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attempt, CAMPAIGN } from "../test/quests.ts";
import * as client from "./client.ts";
import { startGeneration } from "./sync.ts";
import { attemptActivityQuery } from "./workbench.ts";

afterEach(() => vi.restoreAllMocks());

const done = attempt(CAMPAIGN, "completed");

const read = (cleared: boolean): AttemptActivityRead => ({
  cursor: "1:1",
  activity: new AttemptActivity({
    attempt: done,
    commands: [],
    changes: [],
    scans: [],
    artifacts: [],
    detailsClearedAt: cleared ? "2026-11-02T10:00:00.000Z" : null,
  }),
});

describe("an Attempt's records in the Workbench", () => {
  it("reads them again when a new sync generation began while the first read was on its way", async () => {
    const queryClient = new QueryClient();
    let answerFirst: (value: AttemptActivityRead) => void = () => undefined;
    const call = vi
      .spyOn(client, "call")
      .mockReturnValueOnce(
        new Promise((answer) => {
          answerFirst = answer as typeof answerFirst;
        }) as never,
      )
      .mockResolvedValueOnce(read(true) as never);
    const loading = queryClient.fetchQuery(attemptActivityQuery(done.id));
    // A fresh Ready starts a generation while the first read is on its way; then the old read lands.
    startGeneration(queryClient);
    answerFirst(read(false));
    const loaded = await loading;
    expect(call).toHaveBeenCalledTimes(2);
    expect(loaded.activity.detailsClearedAt).not.toBeNull();
    expect(queryClient.getQueryData(attemptActivityQuery(done.id).queryKey)?.activity.detailsClearedAt).not.toBeNull();
  });
});
