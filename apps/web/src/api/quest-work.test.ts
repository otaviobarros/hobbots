import type { MemberWorkRead } from "@hobbots/api";
import { AgentId, type MemberWork } from "@hobbots/domain";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memberWork, quest } from "../test/member-work.ts";
import * as client from "./client.ts";
import { applyEvent } from "./events.ts";
import { questWorkKeys, questWorkQuery } from "./quest-work.ts";

afterEach(() => vi.restoreAllMocks());

/** Reads the test answers one by one when it chooses, as a slow network would. */
const slowReads = () => {
  const answers: Array<(value: MemberWorkRead) => void> = [];
  vi.spyOn(client, "call").mockImplementation(
    () =>
      new Promise((done) => {
        answers.push(done as (value: MemberWorkRead) => void);
      }) as never,
  );
  return {
    count: () => answers.length,
    answer: (index: number, work: ReadonlyArray<MemberWork>) => answers[index]?.({ cursor: "1:1", work }),
  };
};

const QUILL = AgentId.make("quill");
const ADA = AgentId.make("ada");

/** A client with Quill's and Ada's Quest work loaded; answers which of them a later event made stale. */
const loaded = () => {
  const client = new QueryClient();
  const campaign = quest("q1", "aldric");
  client.setQueryData(questWorkKeys.of(QUILL), [memberWork("copy", "quill", campaign)]);
  client.setQueryData(questWorkKeys.of(ADA), [memberWork("build", "ada", campaign)]);
  const stale = () => [QUILL, ADA].filter((id) => client.getQueryState(questWorkKeys.of(id))?.isInvalidated === true);
  return { client, campaign, stale };
};

describe("Quest work from the event stream", () => {
  it("refetches the member a Task was delegated to", () => {
    const { client, campaign, stale } = loaded();
    const work = memberWork("proof", "quill", campaign);
    applyEvent(client, { _tag: "TaskCreated", task: work.task, delegation: work.delegation, milestones: [] });
    expect(stale()).toEqual([QUILL]);
  });

  it("refetches the owner of a Task that moved or completed", () => {
    const { client, campaign, stale } = loaded();
    const work = memberWork("build", "ada", campaign, "blocked");
    applyEvent(client, { _tag: "TaskStateChanged", task: work.task, attempt: null, quest: null });
    expect(stale()).toEqual([ADA]);
    applyEvent(client, { _tag: "TaskCompleted", task: memberWork("copy", "quill", campaign).task, artifacts: [] });
    expect(stale()).toEqual([QUILL, ADA]);
  });

  it("refetches every member when a Quest ends", () => {
    const { client, campaign, stale } = loaded();
    applyEvent(client, { _tag: "QuestCompleted", quest: campaign });
    expect(stale()).toEqual([QUILL, ADA]);
  });

  it("leaves Quest work alone for a step, which has no Delegation", () => {
    const { client, campaign, stale } = loaded();
    const step = memberWork("draft", "quill", campaign).task;
    applyEvent(client, { _tag: "TaskCreated", task: step, delegation: null, milestones: [] });
    expect(stale()).toEqual([]);
  });

  it("reads again when a change arrives while the first read is on its way, so the stale read never shows", async () => {
    const queryClient = new QueryClient();
    const reads = slowReads();
    const campaign = quest("q1", "aldric");
    const loading = queryClient.fetchQuery(questWorkQuery(QUILL));
    await vi.waitFor(() => expect(reads.count()).toBe(1));
    // The Quest ends after the hub read Quill's work but before the answer arrives.
    applyEvent(queryClient, { _tag: "QuestCompleted", quest: campaign });
    reads.answer(0, [memberWork("copy", "quill", campaign)]);
    await vi.waitFor(() => expect(reads.count()).toBe(2));
    reads.answer(1, []);
    expect(await loading).toEqual([]);
  });

  it("keeps the first read when nothing changed while it was on its way", async () => {
    const queryClient = new QueryClient();
    const reads = slowReads();
    const work = [memberWork("copy", "quill", quest("q1", "aldric"))];
    const loading = queryClient.fetchQuery(questWorkQuery(QUILL));
    await vi.waitFor(() => expect(reads.count()).toBe(1));
    // A change to another hob's work does not touch Quill's.
    const other = memberWork("build", "ada", quest("q1", "aldric"));
    applyEvent(queryClient, { _tag: "TaskCompleted", task: other.task, artifacts: [] });
    reads.answer(0, work);
    expect(await loading).toEqual(work);
    expect(reads.count()).toBe(1);
  });
});
