import type { SkillProposalCheck, SkillProposalView } from "@hobbots/api";
import { type SkillProposal, skillProposalOpen } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, call } from "./client.ts";
import { followsEvents } from "./queries.ts";

/**
 * What hobs suggest for the skills library (ADR 029, Proactive hobs). A proposal waits for you in
 * the Inbox under every preset; the hub journals every change, so the list follows the event stream.
 */

const proposalsKey = ["skill-proposals"] as const;

/** The proposals that wait for you, oldest first, then the latest decided ones, newest first. */
export const skillProposalsQuery = queryOptions({
  queryKey: proposalsKey,
  queryFn: () => call((c) => c.skillProposals.list()),
  select: (answer) => answer.proposals,
  ...followsEvents,
});

const NONE: ReadonlyArray<SkillProposalView> = [];

/** The proposals that wait for you now. */
export const waitingProposals = (views: ReadonlyArray<SkillProposalView>): ReadonlyArray<SkillProposalView> =>
  views.filter((view) => skillProposalOpen(view.proposal));

export const useWaitingProposals = (): ReadonlyArray<SkillProposalView> =>
  useQuery({ ...skillProposalsQuery, select: (answer) => waitingProposals(answer.proposals) }).data ?? NONE;

/**
 * A proposal was made or moved: the list is read again. A read still in flight is cancelled first,
 * since it may answer from before the change (STD-REACT-012).
 */
export const skillProposalsChanged = async (queryClient: QueryClient) => {
  await queryClient.cancelQueries({ queryKey: proposalsKey, exact: true });
  await queryClient.invalidateQueries({ queryKey: proposalsKey, exact: true });
};

/** Whether `error` says the proposal was decided elsewhere. */
export const proposalClosed = (error: unknown): boolean =>
  error instanceof ApiError && (error.tag === "SkillProposalDecided" || error.tag === "SkillProposalMissing");

export type ProposalDecision = { readonly _tag: "add"; readonly instructions?: string } | { readonly _tag: "decline" };

/** Add it (as written or edited), or Not now. Settled either way, the list is read again. */
export const useDecideProposal = (proposal: SkillProposal) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (decision: ProposalDecision): Promise<SkillProposal> => {
      const params = { proposalId: proposal.id };
      return decision._tag === "add"
        ? call((c) =>
            c.skillProposals.add({
              params,
              payload: decision.instructions === undefined ? {} : { instructions: decision.instructions },
            }),
          )
        : call((c) => c.skillProposals.decline({ params }));
    },
    onSettled: () => skillProposalsChanged(queryClient),
  });
};

/** What the checks find in your edit before it is added; writes nothing, so the list is not read again. */
export const useCheckProposal = (proposal: SkillProposal) =>
  useMutation({
    mutationFn: (instructions: string): Promise<SkillProposalCheck> =>
      call((c) => c.skillProposals.check({ params: { proposalId: proposal.id }, payload: { instructions } })),
  });
