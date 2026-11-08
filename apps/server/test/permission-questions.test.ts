import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApprovalService } from "@hobbots/agents";
import { APPROVAL_RULE, type RuntimeKind } from "@hobbots/domain";
import { afterEach, describe, expect, it } from "vitest";
import { firstPending, hub, partyHub, send, treeWhen } from "./party-hub.ts";

// Issue #1216: in a party Quest under Balanced, Nettle's brief told it to delete a file and wait for
// a decision. Nettle asked its lead "May I run rm scratch/tmp-notes.txt?", Pip answered yes, and the
// top lead told the user the delete was "approved by Pip as lead, not by you". Only the user decides
// what the policy asks them (PE-006): a lead's answer approves nothing, and the delete still waits
// for the user. Every hob is told so, in its tool descriptions, its briefing, the turn a permission
// question reaches its lead, and the answer it hears back, all of which the hub writes, so it holds
// for every runtime.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const RUNTIMES: ReadonlyArray<RuntimeKind> = ["claude-code", "codex"];

describe.each(RUNTIMES)("a member that asks its lead for permission, on %s", (runtime) => {
  // covers PE-003, PE-006, OR-002
  it("[TC-OR-1216-01] still asks the user before the delete its lead said yes to, and tells every hob only the user approves", async () => {
    const party = partyHub({ lead: runtime, members: runtime, files: true });
    dispose = party.dispose;
    const { run, answers, project, reactions, requests } = party;
    const scratch = join(project, "scratch.txt");
    writeFileSync(scratch, "draft\n");
    const remove = JSON.stringify({ command: "rm scratch.txt", writes: { "scratch.txt": null } });
    // Frodo answers Rook's permission question himself, as Pip did in #1216.
    reactions.push({
      on: "asks, as question",
      lines: [hub("answer", { key: "yes", question_id: "$may.question_id", answer: "Yes, delete it." })],
    });
    // Rook then makes the call, and completes once it has run.
    reactions.push({
      on: "was answered by hob frodo",
      lines: [`fake:run ${remove}`, hub("complete_task", { key: "rook", summary: "Deleted scratch.txt" })],
    });
    await run(
      send([
        "Have Rook tidy the project",
        hub("delegate_task", {
          key: "tidy",
          hob: "Rook",
          brief: ["Delete scratch.txt", hub("ask", { key: "may", question: "May I run rm scratch.txt?" })].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$tidy.task_id"] }),
        `fake:then fake:then ${hub("complete_task", { key: "wrap", delivered: true, summary: "Tidied" })}`,
      ]),
    );

    // The lead's answer went back, yet Balanced still asks you before the delete: it waits for you.
    const pending = await run(firstPending);
    expect(answers.get("yes")).not.toContain("Refused");
    expect(pending.operation).toBe("delete-files");
    expect(pending.state).toBe("pending");
    expect(existsSync(scratch)).toBe(true);

    // Every hob was told only the user approves: the tools, the member's prompt, the lead's
    // briefing, the turn the question reached the lead and the answer the member heard.
    const description = (name: string) =>
      requests[0]?.hubTools?.tools.find((tool) => tool.name === name)?.description ?? "";
    expect(description("answer")).toContain(APPROVAL_RULE);
    expect(description("ask")).toContain("Never ask for permission to make a tool call");
    expect(description("delegate_task")).toContain("Never tell it to ask you before an action");
    const member = requests.find((each) => each.prompt.startsWith("Delete scratch.txt"));
    expect(member?.prompt).toContain(APPROVAL_RULE);
    const asked = requests.find((each) => each.prompt.includes("asks, as question"));
    expect(asked?.prompt).toContain("A question that asks permission for a tool call is not yours to grant");
    expect(asked?.briefing).toContain("never tell the user a lead approved one");
    const answered = requests.find((each) => each.prompt.includes("was answered by hob frodo"));
    expect(answered?.prompt).toContain("A lead's answer approves no tool call");

    // You approve, and only then does the file go and the Quest finish.
    await run(
      ApprovalService.use((approvals) =>
        approvals.decide(pending.id, { decision: "approve", actionDigest: pending.actionDigest }),
      ),
    );
    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    expect(existsSync(scratch)).toBe(false);
    expect(done.quests[0]?.state).not.toBe("active");
  }, 30_000);
});
