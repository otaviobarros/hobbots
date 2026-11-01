import { AgentId } from "@hobbots/domain";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { memberWork, quest } from "../test/member-work.ts";
import { applyEvent } from "./events.ts";
import { questWorkKeys } from "./quest-work.ts";

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
});
