import type { HobProposalView } from "@hobbots/api";
import { type CharmOperationId, hobProposalOpen, type SummoningDraft } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, call } from "./client.ts";
import { followsEvents } from "./queries.ts";

/**
 * Hob proposals (ADR 034, Asking is a proposal): a Summoning call that asks waits for you as a card
 * with a row per hob, in the Inbox and on the call's step. The hub journals every change, so the
 * list follows the event stream.
 */

const proposalsKey = ["hob-proposals"] as const;

/** The proposals that wait for you, oldest first, then the latest that settled, newest first. */
export const hobProposalsQuery = queryOptions({
  queryKey: proposalsKey,
  queryFn: () => call((c) => c.hobProposals.list()),
  select: (answer) => answer.proposals,
  ...followsEvents,
});

const NONE: ReadonlyArray<HobProposalView> = [];

/** The proposals that wait for you now. */
export const waitingHobProposals = (views: ReadonlyArray<HobProposalView>): ReadonlyArray<HobProposalView> =>
  views.filter((view) => hobProposalOpen(view.proposal));

export const useWaitingHobProposals = (): ReadonlyArray<HobProposalView> =>
  useQuery({ ...hobProposalsQuery, select: (answer) => waitingHobProposals(answer.proposals) }).data ?? NONE;

/** One proposal as its card shows it, for a reply step that waits on it. */
export const hobProposalQuery = (proposalId: string) =>
  queryOptions({
    queryKey: [...proposalsKey, proposalId] as const,
    queryFn: () => call((c) => c.hobProposals.get({ params: { proposalId } })),
    ...followsEvents,
  });

/**
 * A proposal was made or moved: the list and each card read it again. A read still in flight is
 * cancelled first, since it may answer from before the change (STD-REACT-012).
 */
export const hobProposalsChanged = async (queryClient: QueryClient) => {
  await queryClient.cancelQueries({ queryKey: proposalsKey });
  await queryClient.invalidateQueries({ queryKey: proposalsKey });
};

/** Whether `error` says the proposal or the row was decided elsewhere. */
export const hobProposalClosed = (error: unknown): boolean =>
  error instanceof ApiError && (error.tag === "HobProposalDecided" || error.tag === "HobProposalMissing");

/** What you decide on a proposal card. */
export type HobProposalDecision =
  | { readonly _tag: "allow"; readonly rowId: string; readonly edited?: SummoningDraft; readonly confirmed?: boolean }
  | { readonly _tag: "deny"; readonly rowId: string }
  | { readonly _tag: "allowAll"; readonly confirmed?: boolean }
  | { readonly _tag: "denyAll" }
  | { readonly _tag: "alwaysAllow"; readonly operation: CharmOperationId };

const decisionCall = (proposalId: string, decision: HobProposalDecision) => {
  const params = { proposalId };
  switch (decision._tag) {
    case "allow":
      return call((c) =>
        c.hobProposals.allow({
          params: { ...params, rowId: decision.rowId },
          payload: {
            ...(decision.edited === undefined ? {} : { edited: decision.edited }),
            ...(decision.confirmed === undefined ? {} : { confirmed: decision.confirmed }),
          },
        }),
      );
    case "deny":
      return call((c) => c.hobProposals.deny({ params: { ...params, rowId: decision.rowId } }));
    case "allowAll":
      return call((c) =>
        c.hobProposals.allowAll({
          params,
          payload: decision.confirmed === undefined ? {} : { confirmed: decision.confirmed },
        }),
      );
    case "denyAll":
      return call((c) => c.hobProposals.denyAll({ params }));
    default:
      return call((c) => c.hobProposals.alwaysAllow({ params, payload: { operation: decision.operation } }));
  }
};

/** Decides a proposal; settled either way, the list and the cards are read again. */
export const useDecideHobProposal = (proposalId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (decision: HobProposalDecision): Promise<HobProposalView> => decisionCall(proposalId, decision),
    onSettled: () => hobProposalsChanged(queryClient),
  });
};
