import { Message, MessageId, type ReplyStep, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { BRIEFING_LIMITS, buildBriefing } from "../src/briefing.ts";

let next = 0;
const message = (role: "user" | "assistant", content: string, fields: Partial<Message> = {}) =>
  new Message({
    id: MessageId.make(`m${++next}`),
    threadId: ThreadId.make("t"),
    role,
    content,
    status: "complete",
    error: null,
    configVersion: role === "assistant" ? 1 : null,
    runtime: role === "assistant" ? "claude-code" : null,
    model: role === "assistant" ? "sonnet" : null,
    createdAt: "2026-11-01T00:00:00.000Z",
    ...fields,
  });

const tool = (label: string, state: ReplyStep["state"], reason?: string): ReplyStep => ({
  id: label,
  kind: "tool",
  label,
  state,
  call: { tool: "Bash", operation: "run-commands", targets: ["/work"] },
  ...(reason === undefined ? {} : { reason }),
});

describe("buildBriefing", () => {
  // covers RT-001, CH-001
  it("[TC-CH-131] keeps the latest messages verbatim, summarizes older ones with their tool steps, and reuses the checkpoint", () => {
    // Nothing to tell, nothing told.
    expect(buildBriefing({ kind: "new", messages: [], checkpoint: null })).toBeNull();

    const long = "x".repeat(BRIEFING_LIMITS.message + 500);
    const older = Array.from({ length: 12 }, (_, i) =>
      message(i % 2 === 0 ? "user" : "assistant", `older ${i} ${"y".repeat(3_000)}`, {
        ...(i === 1 ? { steps: [tool("Ran pnpm test", "done"), tool("Push", "denied", "needs approval")] } : {}),
      }),
    );
    const latest = [message("user", long), message("assistant", "Done.", { status: "limited" })];
    const briefing = buildBriefing({ kind: "new", messages: [...older, ...latest], checkpoint: null });

    expect(briefing).not.toBeNull();
    const text = briefing?.text ?? "";
    expect(text).toMatch(/^## This thread so far\n\nYou are picking up this thread from Claude Code\./);
    expect(text).toContain("### Earlier, in summary");
    // Older messages become one clipped line each, a reply's tool calls included.
    expect(text).toContain("- You, thinking with Claude Code · sonnet: older 1 ");
    expect(text).toContain("Tools: Ran pnpm test (done); Push (denied: needs approval)");
    // A long latest message keeps its start and end; a limited reply says how it ended.
    expect(text).toContain(`${"x".repeat(BRIEFING_LIMITS.message / 2)}\n[…]\n`);
    expect(text).toContain("**You, thinking with Claude Code · sonnet:** [ended by the provider's usage limit]\nDone.");
    expect(text.endsWith("## Now")).toBe(true);
    expect(text.length).toBeLessThan(BRIEFING_LIMITS.verbatim + BRIEFING_LIMITS.summary + 2_000);

    // The summary is offered as the thread's checkpoint, through the last message it covers.
    const checkpoint = briefing?.checkpoint;
    expect(checkpoint).not.toBeNull();
    const covered = older.findIndex((m) => m.id === checkpoint?.throughMessageId);
    expect(covered).toBeGreaterThan(-1);
    expect(checkpoint?.lines.length).toBeGreaterThan(0);

    // The next handoff starts from the checkpoint instead of summarizing again, and stores nothing
    // new when nothing new was summarized.
    const stored = { ...(checkpoint as NonNullable<typeof checkpoint>), lines: ["- (from the checkpoint)"] };
    const again = buildBriefing({ kind: "new", messages: [...older, ...latest], checkpoint: stored });
    expect(again?.text).toContain("- (from the checkpoint)");
    expect(again?.text).not.toContain(`older ${covered - 1} `);
    expect(again?.checkpoint).toBeNull();

    // A summary over its budget drops its oldest lines and says how many.
    const many = Array.from({ length: 200 }, (_, i) => message("user", `note ${i} ${"z".repeat(300)}`));
    const capped = buildBriefing({ kind: "new", messages: [...many, ...latest], checkpoint: null });
    expect(capped?.text).toMatch(/\((\d+) earlier messages left out\.\)/);
    expect(capped?.checkpoint?.omitted).toBeGreaterThan(0);
    expect(capped?.checkpoint?.lines.join("\n").length).toBeLessThanOrEqual(BRIEFING_LIMITS.summary);

    // A resumed session is told what it missed, and never reuses the thread's checkpoint.
    const resumed = buildBriefing({ kind: "resumed", messages: latest, checkpoint: stored });
    expect(resumed?.text).toMatch(/^## Since your last reply/);
    expect(resumed?.text).not.toContain("(from the checkpoint)");
    expect(resumed?.checkpoint).toBeNull();
  });
});
