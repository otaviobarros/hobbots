import { AgentId, DeviceId, Question, QuestionId, TaskId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { yourAnswer } from "./your-answer.ts";

// Issue #671: an answered question says where you answered it, so an answer given in the Task's
// drawer can be told from one given in the Inbox or the chat.
const answered = (fields: Partial<ConstructorParameters<typeof Question>[0]>) =>
  new Question({
    id: QuestionId.make("q1"),
    taskId: TaskId.make("t1"),
    askerId: AgentId.make("rook"),
    recipientId: null,
    chain: [],
    text: "Light or dark?",
    state: "answered",
    answer: "light",
    answeredBy: { _tag: "User" },
    createdAt: "2026-11-03T19:22:54.000Z",
    answeredAt: "2026-11-03T19:23:11.000Z",
    answeredByDeviceId: DeviceId.make("window"),
    answeredVia: "task",
    revision: 3,
    ...fields,
  });

describe("your answer", () => {
  it("[TC-IN-487] says you answered here on the same surface, and names the other surface elsewhere", () => {
    expect(yourAnswer(answered({}), "task")).toBe("You answered here: light");
    expect(yourAnswer(answered({}), "chat")).toBe("You answered in the quest: light");
    expect(yourAnswer(answered({ answeredVia: "inbox" }), "task")).toBe("You answered in the Inbox: light");
    expect(yourAnswer(answered({ answeredVia: "chat" }), "task")).toBe("You answered in the chat: light");
  });

  it("[TC-IN-488] just says you answered when nobody recorded where, and nothing for a lead's answer or an open question", () => {
    expect(yourAnswer(answered({ answeredVia: null, answeredByDeviceId: null }), "task")).toBe("You answered: light");
    expect(yourAnswer(answered({ answeredBy: { _tag: "Lead", agentId: AgentId.make("aldric") } }), "task")).toBeNull();
    expect(yourAnswer(answered({ state: "open", answer: null, answeredBy: null }), "task")).toBeNull();
  });
});
