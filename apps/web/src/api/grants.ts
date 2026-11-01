import type { Grant, GrantId } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";

const grantsKey = ["grants"] as const;

/** The grants that apply now, of every hob, oldest first (ADR 015). */
export const grantsQuery = queryOptions({
  queryKey: grantsKey,
  queryFn: () => call((c) => c.grants.list({ query: {} })),
});

/**
 * A grant was saved or ended, here or elsewhere: the list is read again, so it shows only the
 * grants that apply now whatever order the event and a pending read arrive in. A read already in
 * flight may have been taken before the change, and while the list has no data yet Query would
 * hand that read back instead of starting another, so it is cancelled first.
 */
export const grantsChanged = async (queryClient: QueryClient) => {
  await queryClient.cancelQueries({ queryKey: grantsKey, exact: true });
  await queryClient.invalidateQueries({ queryKey: grantsKey, exact: true });
};

/**
 * The user removes a standing rule. The hub keeps it as revoked, and the next call it matched asks
 * again; a host rule also stops the hob's running replies. Removing one already gone succeeds.
 */
export const useRevokeGrant = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (grantId: GrantId) => call((c) => c.grants.revoke({ params: { grantId } })),
    onSuccess: (revoked: Grant) => {
      queryClient.setQueryData<ReadonlyArray<Grant>>(grantsKey, (old) =>
        old?.filter((grant) => grant.id !== revoked.id),
      );
      return grantsChanged(queryClient);
    },
  });
};
