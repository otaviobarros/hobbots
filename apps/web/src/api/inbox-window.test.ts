import { AgentId, ApprovalId, ApprovalRequest, INBOX_HISTORY, MessageId, ThreadId } from "@hobbots/domain";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { approvalQuery, inboxQuery, storeApproval } from "./approvals.ts";
import { inboxWindow } from "./inbox-window.ts";
import { startGeneration, syncedApproval } from "./sync.ts";

const at = (n: number) => new Date(Date.UTC(2026, 10, 1) + n * 60_000).toISOString();

const request = (n: number, state: ApprovalRequest["state"], decided = n) =>
  new ApprovalRequest({
    id: ApprovalId.make(`r${String(n).padStart(4, "0")}`),
    agentId: AgentId.make("pip"),
    threadId: ThreadId.make("t1"),
    messageId: MessageId.make("m1"),
    stepId: "tool-1",
    tool: "Bash",
    operation: "push",
    targets: [],
    arguments: {},
    label: "Push",
    reason: "Pushing asks first.",
    actionDigest: "d",
    policyVersion: "r1",
    state,
    denyReason: null,
    createdAt: at(n),
    decidedAt: state === "pending" ? null : at(decided),
  });

const closed = (count: number) => Array.from({ length: count }, (_, n) => request(n, "denied"));

describe("inboxWindow", () => {
  it("keeps every pending request and the most recently closed ones, oldest first", () => {
    const old = request(-1, "pending");
    // The oldest closed request was decided last, so it stays and the next oldest goes.
    const lateDecision = request(0, "expired", 10_000);
    const all = [old, lateDecision, ...closed(INBOX_HISTORY + 1).slice(1)];
    const kept = inboxWindow(all);
    expect(kept).toHaveLength(INBOX_HISTORY + 1);
    expect(kept.map((r) => r.id).slice(0, 3)).toEqual(["r00-1", "r0000", "r0002"]);
  });
});

describe("storeApproval on the Inbox", () => {
  // covers PE-003
  it("[TC-IN-005] a decision arriving live never grows History past its window", () => {
    const client = new QueryClient();
    const pending = request(500, "pending");
    client.setQueryData(inboxQuery.queryKey, [...closed(INBOX_HISTORY), pending]);
    storeApproval(client, new ApprovalRequest({ ...pending, state: "approved", decidedAt: at(600), revision: 2 }));
    const inbox = client.getQueryData<ReadonlyArray<ApprovalRequest>>(inboxQuery.queryKey) ?? [];
    expect(inbox).toHaveLength(INBOX_HISTORY);
    expect(inbox.at(-1)?.id).toBe("r0500");
    expect(inbox.some((r) => r.id === "r0000")).toBe(false);
  });
});

// A fetch the test answers by hand, to land a response after events that happened while it was in flight.
const pendingFetch = () => {
  const answers: Array<(row: ApprovalRequest) => void> = [];
  const fetch = () => new Promise<ApprovalRequest>((resolve) => void answers.push(resolve));
  return { fetch, answer: (row: ApprovalRequest) => answers.shift()?.(row), pending: () => answers.length };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
// The request's own query, with the hub call swapped for the test's.
const read = (client: QueryClient, approvalId: string, fetch: () => Promise<ApprovalRequest>) =>
  client.fetchQuery({ ...approvalQuery(approvalId), queryFn: syncedApproval(approvalId, fetch) });

describe("approvalQuery, the request open beside the list", () => {
  const pending = request(500, "pending");
  const approved = new ApprovalRequest({ ...pending, state: "approved", decidedAt: at(600), revision: 2 });

  // covers PE-003
  it("[TC-IN-006] a fresh snapshot replaces the pending version the client last saw", async () => {
    const client = new QueryClient();
    client.setQueryData(approvalQuery(pending.id).queryKey, pending);
    // The client missed the decision: a fresh Ready drops what it knew and reads the hub again.
    startGeneration(client);
    const fresh = await read(client, pending.id, () => Promise.resolve(approved));
    expect(fresh).toBe(approved);
    expect(client.getQueryData(approvalQuery(pending.id).queryKey)).toBe(approved);
  });

  // covers PE-003
  it("[TC-IN-007] keeps a decision that arrived while the read was in flight, and reads again after a fresh Ready", async () => {
    const client = new QueryClient();
    const { fetch, answer, pending: waiting } = pendingFetch();
    const loading = read(client, pending.id, fetch);
    storeApproval(client, approved);
    answer(pending);
    expect(await loading).toBe(approved);

    const again = read(client, "r0501", fetch);
    startGeneration(client);
    answer(request(501, "pending"));
    await settle();
    expect(waiting()).toBe(1);
    const expired = new ApprovalRequest({ ...request(501, "expired"), revision: 3 });
    answer(expired);
    expect(await again).toBe(expired);
  });

  // covers PE-003
  it("[TC-IN-008] a decision arriving live updates the request read on its own", () => {
    const client = new QueryClient();
    client.setQueryData(approvalQuery(pending.id).queryKey, pending);
    storeApproval(client, approved);
    expect(client.getQueryData(approvalQuery(pending.id).queryKey)).toBe(approved);
    // A request nobody has open is not read into the cache.
    storeApproval(client, request(7, "denied"));
    expect(client.getQueryData(approvalQuery("r0007").queryKey)).toBeUndefined();
  });
});
