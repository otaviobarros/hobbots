import type {
  AgentId,
  AgentStatus,
  ApprovalRequest,
  BackpackItem,
  HobPresenceState,
  Question,
  ReplyActivity,
} from "@hobbots/domain";

/**
 * Sprite states from the design sprite sheet that the current build can show, plus paused. `waiting`
 * waits on you; `on-command` has answered and waits only on a command it started (#1056).
 */
export type HobState =
  | "idle"
  | "thinking"
  | "working"
  | "on-command"
  | "waiting"
  | "needs-you"
  | "asleep"
  | "paused"
  | "failed";

/** Words for a state, for headers and screen readers. */
export const stateLabel: Record<HobState, string> = {
  idle: "ready",
  thinking: "thinking",
  working: "working",
  "on-command": "waiting on a command",
  waiting: "waiting",
  "needs-you": "needs you",
  asleep: "asleep",
  paused: "paused",
  failed: "had a problem",
};

/**
 * A hob's state as the hub published its presence (ADR 037): every presence is a sprite state. Until
 * the hub's status is read, or when the read failed, the hob's own record still says it is paused,
 * and otherwise it rests; the window says the status could not be read (`HubReadCard`).
 */
export const presenceState = (presence: HobPresenceState | undefined, status: AgentStatus): HobState =>
  presence ?? (status === "paused" ? "paused" : "idle");

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
 * One thread's state for the chat header, from what the hub published: the hob's presence when it is
 * paused, since its lifecycle comes first, then what the thread's running reply is doing.
 */
export const threadState = (
  presence: HobPresenceState | undefined,
  reply: ReplyActivity | undefined,
  status: AgentStatus,
): HobState => {
  if (presenceState(presence, status) === "paused") return "paused";
  if (reply === "waiting") return "on-command";
  return reply ?? "idle";
};

// Who stands in front of the scene: those who need you, then the busiest, then the rest.
const sceneRank: Record<HobState, number> = {
  "needs-you": 0,
  waiting: 1,
  failed: 2,
  working: 3,
  "on-command": 3,
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
