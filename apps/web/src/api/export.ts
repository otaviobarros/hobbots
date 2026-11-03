import type { ExportPayload } from "@hobbots/api";
import { queryOptions, useMutation } from "@tanstack/react-query";
import { call } from "./client.ts";

/** Where Hobbots offers to save an export on the hub: its user's Downloads folder, or home without one. */
export const exportDestinationQuery = queryOptions({
  queryKey: ["exports", "destination"] as const,
  queryFn: () => call((c) => c.exports.destination()),
  staleTime: Number.POSITIVE_INFINITY,
});

/** Writes an export on the hub (ADR 026) and resolves with its folder and what it holds. */
export const useExport = () =>
  useMutation({ mutationFn: (payload: ExportPayload) => call((c) => c.exports.create({ payload })) });
