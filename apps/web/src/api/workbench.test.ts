import type { AttemptActivityRead } from "@hobbots/api";
import { AttemptActivity, CommandId } from "@hobbots/domain";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attempt, CAMPAIGN } from "../test/quests.ts";
import * as client from "./client.ts";
import { startGeneration } from "./sync.ts";
import { addOutput, applyCommandOutput, attemptActivityQuery, liveOutputQuery } from "./workbench.ts";

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
    sharedWithHobs: [],
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

describe("a running command's output", () => {
  const RUN = CommandId.make("run");
  const piece = (offset: number, delta: string) => ({
    _tag: "CommandOutput" as const,
    attemptId: done.id,
    taskId: CAMPAIGN,
    commandId: RUN,
    offset,
    delta,
  });

  it("adds each piece by its offset, so a repeated or overlapping piece adds nothing twice", () => {
    let outputs = addOutput({}, piece(0, "one\n"));
    outputs = addOutput(outputs, piece(4, "two\n"));
    expect(addOutput(outputs, piece(4, "two\n"))).toBe(outputs);
    outputs = addOutput(outputs, piece(4, "two\nthree\n"));
    expect(outputs[RUN]).toEqual({ text: "one\ntwo\nthree\n", end: 14, missed: false });
  });

  it("marks the gap when a piece starts past what this client saw, then follows on from where that piece ended", () => {
    let outputs = addOutput(addOutput({}, piece(0, "one\n")), piece(20, "later\n"));
    expect(outputs[RUN]).toEqual({ text: "later\n", end: 26, missed: true });
    outputs = addOutput(outputs, piece(26, "next\n"));
    // A piece repeated after the gap, whole or overlapping, adds nothing twice.
    expect(addOutput(outputs, piece(26, "next\n"))).toBe(outputs);
    expect(addOutput(outputs, piece(20, "later\n"))).toBe(outputs);
    outputs = addOutput(outputs, piece(26, "next\nlast\n"));
    expect(outputs[RUN]).toEqual({ text: "later\nnext\nlast\n", end: 36, missed: true });
  });

  it("keeps what it saw across a new sync generation, since the hub has nothing to read it again from", async () => {
    const queryClient = new QueryClient();
    applyCommandOutput(queryClient, piece(0, "one\n"));
    startGeneration(queryClient);
    expect(await queryClient.fetchQuery(liveOutputQuery(done.id))).toEqual({
      [RUN]: { text: "one\n", end: 4, missed: false },
    });
  });
});
