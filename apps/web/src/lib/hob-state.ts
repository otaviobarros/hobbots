import type { Agent, AgentId, ApprovalRequest, BackpackItem, FailedTask, Question, ThreadId } from "@hobbots/domain";

/** Sprite states from the design sprite sheet that the current build can show, plus paused. */
export type HobState = "idle" | "thinking" | "working" | "waiting" | "needs-you" | "asleep" | "paused" | "failed";

/** Words for a state, for headers and screen readers. */
export const stateLabel: Record<HobState, string> = {
  idle: "ready",
  thinking: "thinking",
  working: "working",
  waiting: "waiting",
  "needs-you": "needs you",
  asleep: "asleep",
  paused: "paused",
  failed: "had a problem",
};

/**
 * The one place a hob's state is worked out: its lifecycle (AG-006) first, then what its threads are
 * doing. Retired hobs leave the hob list, so only active and paused hobs reach it.
 * A paused hob shows as paused even while a reply it started before the pause finishes streaming.
 */
export const hobState = (
  hob: Pick<Agent, "status">,
  threads: ReadonlyArray<{ readonly id: string }> | undefined,
  activity: Readonly<Record<string, "thinking" | "working">>,
): HobState => {
  if (hob.status === "paused") return "paused";
  const states = (threads ?? []).map((t) => activity[t.id]).filter((a) => a !== undefined);
  if (states.includes("working")) return "working";
  return states.length > 0 ? "thinking" : "idle";
};

/**
 * A hob with a request waiting for the user needs you, whatever its threads are doing; a paused
 * hob stays paused, since its lifecycle comes first.
 */
export const withRequests = (state: HobState, waiting: boolean): HobState =>
  waiting && state !== "paused" ? "needs-you" : state;

/**
 * What a hob waits on you for, the first of its kind in the tray's order: a request to approve,
 * then stuck work, then a question. A question names the hob that asked; when the hob holding it is
 * a lead it passed up to you, `askerId` is another hob.
 */
export type HobNeed =
  | { readonly kind: "approval"; readonly operation: ApprovalRequest["operation"] }
  | { readonly kind: "stuck"; readonly item: BackpackItem }
  | { readonly kind: "question"; readonly text: string; readonly askerId: AgentId };

/**
 * The hobs waiting on you and what each waits for. A question marks the hob that asked, so the
 * marks name the same hob as the tray, and also the lead whose chat it waits in: the last to pass it
 * up. `blockers` are the open ones and `questions` the ones waiting for you.
 */
export const hobNeeds = ({
  approvals,
  blockers,
  questions,
}: {
  readonly approvals: ReadonlyArray<Pick<ApprovalRequest, "agentId" | "operation" | "state">>;
  readonly blockers: ReadonlyArray<BackpackItem>;
  readonly questions: ReadonlyArray<{ readonly question: Pick<Question, "askerId" | "chain" | "text"> }>;
}): ReadonlyMap<AgentId, HobNeed> => {
  const needs = new Map<AgentId, HobNeed>();
  const add = (hobId: AgentId, need: HobNeed) => {
    if (!needs.has(hobId)) needs.set(hobId, need);
  };
  for (const request of approvals)
    if (request.state === "pending") add(request.agentId, { kind: "approval", operation: request.operation });
  for (const item of blockers) add(item.recipientId, { kind: "stuck", item });
  for (const { question } of questions) {
    const need = { kind: "question", text: question.text, askerId: question.askerId } as const;
    add(question.askerId, need);
    add(question.chain.at(-1) ?? question.askerId, need);
  }
  return needs;
};

/**
 * The hobs whose tile in the sidebar is marked as needing you (ADR 027). You talk only to the lead,
 * so what waits on you marks the hob whose chat it waits in: a request, stuck work or a member's
 * failed Task by the chat its work was asked in, and a question by the last lead it climbed. The
 * hob that asks keeps its own state. `leadOf` names the hob a chat belongs to, when it is known.
 */
export const leadNeeds = ({
  approvals,
  blockers,
  questions,
  failed,
  leadOf,
}: {
  readonly approvals: ReadonlyArray<Pick<ApprovalRequest, "agentId" | "threadId" | "state">>;
  readonly blockers: ReadonlyArray<Pick<BackpackItem, "recipientId" | "threadId">>;
  readonly questions: ReadonlyArray<{ readonly question: Pick<Question, "askerId" | "chain"> }>;
  readonly failed: ReadonlyArray<FailedTask>;
  readonly leadOf: (threadId: ThreadId) => AgentId | undefined;
}): ReadonlySet<AgentId> => {
  const lead = (threadId: ThreadId | null, otherwise: AgentId) =>
    (threadId === null ? undefined : leadOf(threadId)) ?? otherwise;
  return new Set([
    ...approvals.flatMap((request) => (request.state === "pending" ? [lead(request.threadId, request.agentId)] : [])),
    ...blockers.map((item) => lead(item.threadId, item.recipientId)),
    ...questions.map(({ question }) => question.chain.at(-1) ?? question.askerId),
    ...failed.map(({ task, leadId }) => leadId ?? lead(task.threadId, task.ownerId)),
  ]);
};

/**
 * One thread's state for the chat header. The hob's lifecycle wins here too, so the header agrees
 * with the sidebar and Home while a reply started before the pause finishes.
 */
export const threadState = (
  hob: Pick<Agent, "status">,
  activity: "thinking" | "working" | undefined,
  streaming: boolean,
): HobState => {
  if (hob.status === "paused") return "paused";
  return activity ?? (streaming ? "working" : "idle");
};

// Who stands in front of the scene: those who need you, then the busiest, then the rest.
const sceneRank: Record<HobState, number> = {
  "needs-you": 0,
  waiting: 1,
  failed: 2,
  working: 3,
  thinking: 4,
  idle: 5,
  asleep: 6,
  paused: 7,
};

/** Orders hobs for the Home scene; hobs in the same state keep their order. */
export const sceneOrder = <T extends { readonly state: HobState }>(crew: ReadonlyArray<T>): Array<T> =>
  crew
    .map((member, index) => ({ member, index }))
    .sort((a, b) => sceneRank[a.member.state] - sceneRank[b.member.state] || a.index - b.index)
    .map(({ member }) => member);
