import type { HobSkills } from "@hobbots/api";
import { AgentId, type SkillName } from "@hobbots/domain";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { hobSkillsChanged, hobSkillsQuery } from "./hob-skills.ts";

const PIP = AgentId.make("pip");

// Only the names matter here: each read answers with the skills the hub had when it was taken.
const view = (...names: ReadonlyArray<string>) =>
  ({ agentId: PIP, skills: names.map((name) => ({ name: name as SkillName })) }) as unknown as HobSkills;

/** A hob's skills on screen whose reads answer only when the test says so, in order. */
const watched = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pending: Array<(value: HobSkills) => void> = [];
  const observer = new QueryObserver(client, {
    ...hobSkillsQuery(PIP),
    queryFn: () => new Promise<HobSkills>((resolve) => pending.push(resolve)),
  });
  const unsubscribe = observer.subscribe(() => {});
  const answer = (n: number, value: HobSkills) => pending[n]?.(value);
  const shown = () => observer.getCurrentResult().data?.skills.map((skill) => skill.name);
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { client, answer, shown, settled, reads: () => pending.length, unsubscribe };
};

describe("hobSkillsChanged (ADR 029)", () => {
  it("[TC-UI-1096-08] drops a first read taken before a skill was assigned, so the new skill shows", async () => {
    const skills = watched();
    expect(skills.reads()).toBe(1);
    const changed = hobSkillsChanged(skills.client);
    await skills.settled();
    expect(skills.reads()).toBe(2);
    skills.answer(0, view("release"));
    skills.answer(1, view("release", "review"));
    await changed;
    await skills.settled();
    expect(skills.shown()).toEqual(["release", "review"]);
    skills.unsubscribe();
  });

  it("[TC-UI-1096-09] reads a loaded hob's skills again, while they are fresh, so one taken off goes", async () => {
    const skills = watched();
    skills.answer(0, view("release", "review"));
    await skills.settled();
    expect(skills.shown()).toEqual(["release", "review"]);
    const changed = hobSkillsChanged(skills.client);
    await skills.settled();
    expect(skills.reads()).toBe(2);
    skills.answer(1, view("review"));
    await changed;
    await skills.settled();
    expect(skills.shown()).toEqual(["review"]);
    skills.unsubscribe();
  });
});
