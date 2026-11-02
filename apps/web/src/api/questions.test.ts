import type { WaitingQuestion } from "@hobbots/api";
import type { Question, Task } from "@hobbots/domain";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { questionChanged, waitingQuestionsQuery, workEnded } from "./questions.ts";

// Only ids, states and recipients matter here: each read answers with what the hub had when it was taken.
const waiting = (id: string, taskId = "keywords", rootId = "campaign") =>
  ({ question: { id }, task: { id: taskId, rootId } }) as unknown as WaitingQuestion;
const question = (id: string, fields: Partial<Question> = {}) =>
  ({ id, state: "open", recipientId: null, ...fields }) as unknown as Question;
const ended = (id: string) => ({ id, state: "cancelled" }) as unknown as Task;

/**
 * The Inbox's questions on screen, whose reads answer only when the test says so: `answer(n, …)`
 * settles the nth read with what the hub had when that read was taken.
 */
const watchedList = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pending: Array<(value: ReadonlyArray<WaitingQuestion>) => void> = [];
  const observer = new QueryObserver(client, {
    ...waitingQuestionsQuery,
    queryFn: () => new Promise<ReadonlyArray<WaitingQuestion>>((resolve) => pending.push(resolve)),
  });
  const unsubscribe = observer.subscribe(() => {});
  const answer = (n: number, value: ReadonlyArray<WaitingQuestion>) => pending[n]?.(value);
  const shown = () => observer.getCurrentResult().data?.map((each) => each.question.id);
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { client, answer, shown, settled, reads: () => pending.length, unsubscribe };
};

describe("questionChanged", () => {
  // covers OR-002, IN-004
  it("[TC-IN-133] drops a first read taken before a question reached you, so the question shows", async () => {
    const list = watchedList();
    const changed = questionChanged(list.client, question("q1"));
    await list.settled();
    expect(list.reads()).toBe(2);
    list.answer(1, [waiting("q1")]);
    list.answer(0, []);
    await changed;
    await list.settled();
    expect(list.shown()).toEqual(["q1"]);
    list.unsubscribe();
  });

  it("takes an answered question out at once, and a read taken before the answer cannot bring it back", async () => {
    const list = watchedList();
    list.answer(0, [waiting("q1")]);
    await list.settled();
    const first = questionChanged(list.client, question("q2"));
    await list.settled();
    const answered = questionChanged(list.client, question("q1", { state: "answered" }));
    expect(list.shown()).toEqual([]);
    await list.settled();
    list.answer(1, [waiting("q1"), waiting("q2")]);
    list.answer(2, [waiting("q2")]);
    await Promise.all([first, answered]);
    await list.settled();
    expect(list.shown()).toEqual(["q2"]);
    list.unsubscribe();
  });

  it("reads nothing when a question only moves from one lead to another", async () => {
    const list = watchedList();
    list.answer(0, []);
    await list.settled();
    await questionChanged(list.client, question("q1", { recipientId: "ada" as Question["recipientId"] }));
    expect(list.reads()).toBe(1);
    list.unsubscribe();
  });
});

describe("workEnded", () => {
  // covers OR-002, IN-004
  it("[TC-IN-134] keeps a question about ended work out, even when a read taken before the end answers late", async () => {
    const list = watchedList();
    list.answer(0, [waiting("q1"), waiting("q2", "copy", "other")]);
    await list.settled();
    const late = questionChanged(list.client, question("q3"));
    await list.settled();
    const done = workEnded(list.client, ended("campaign"));
    expect(list.shown()).toEqual(["q2"]);
    await list.settled();
    list.answer(1, [waiting("q1"), waiting("q2", "copy", "other"), waiting("q3")]);
    list.answer(2, [waiting("q2", "copy", "other")]);
    await Promise.all([late, done]);
    await list.settled();
    expect(list.shown()).toEqual(["q2"]);
    list.unsubscribe();
  });

  it("reads nothing when the work that ended has no question waiting", async () => {
    const list = watchedList();
    list.answer(0, [waiting("q1")]);
    await list.settled();
    await workEnded(list.client, ended("other"));
    expect(list.reads()).toBe(1);
    list.unsubscribe();
  });
});
