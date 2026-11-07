import { afterEach, describe, expect, it } from "vitest";
import { hub, ownedBy, PIP, partyHub, QUILL, send, treeWhen } from "./party-hub.ts";

// Issue #574, review of #646: a lead can message a member's Task before the member's first session
// starts. That first turn carries the message with its Task, so its prompt must show it, or the
// message is consumed unread.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const MESSAGE = "The staging database is back; use it.";

describe("a lead's message before the member starts", () => {
  // covers OR-002, IN-001, IN-004
  it("[TC-OR-259] reaches the member in the prompt of its first turn on the Task", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run, requests, answers, gates, reactions } = party;
    // Pip's Task waits for Quill's, and Quill finishes only once Frodo's message to Pip is sent.
    gates.set("schema-done", async () => {
      while (!answers.has("tell")) await new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Frodo wraps up in the turn that brings Pip's result, however the two results reach him.
    reactions.push({
      on: "(Run the migration) finished.",
      lines: [hub("complete_task", { delivered: true, key: "wrap", summary: "Migration shipped" })],
    });
    await run(
      send([
        "Ship the migration",
        hub("delegate_task", {
          key: "schema",
          hob: "Quill",
          brief: [
            "Write the schema",
            hub("complete_task", { delivered: true, key: "schema-done", summary: "Schema written" }),
          ].join("\n"),
        }),
        hub("delegate_task", {
          key: "migrate",
          hob: "Pip",
          brief: [
            "Run the migration",
            hub("complete_task", { delivered: true, key: "migrate-done", summary: "Migrated" }),
          ].join("\n"),
          depends_on: ["$schema.task_id"],
        }),
        hub("message_task", { key: "tell", task_id: "$migrate.task_id", text: MESSAGE }),
        hub("wait_for", { key: "wait", tasks: ["$schema.task_id", "$migrate.task_id"] }),
      ]),
    );

    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    expect(answers.get("tell")).toContain("Sent to hob");
    expect(ownedBy(done, QUILL)?.result?.summary).toBe("Schema written");
    expect(ownedBy(done, PIP)?.result?.summary).toBe("Migrated");

    // Pip started on the Task once, and that first turn told him what Frodo sent.
    // A member's session starts from its lead's brief.
    const pips = requests.filter((request) => request.prompt.startsWith("Run the migration"));
    expect(pips).toHaveLength(1);
    expect(pips[0]?.prompt).toContain("Run the migration");
    expect(pips[0]?.prompt).toContain("This also arrived for you before you started:");
    expect(pips[0]?.prompt).toContain(MESSAGE);
  }, 20_000);
});
