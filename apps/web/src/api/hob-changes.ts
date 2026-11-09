import type { AgentId, HobbotsEvent } from "@hobbots/domain";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { Option, Schema } from "effect";
import { readStored, writeStored } from "../lib/storage.ts";
import { call } from "./client.ts";
import { followsEvents, useHobChange } from "./queries.ts";

/** Each hob's History and the Changes log, under one prefix so any change to a hob reads them again. */
const changeKeys = {
  all: ["hobChanges"] as const,
  hob: (hobId: AgentId) => ["hobChanges", "hob", hobId] as const,
  log: ["hobChanges", "log"] as const,
};

/** Every change to a hob, newest first (ADR 034). */
export const hobChangesQuery = (hobId: AgentId) =>
  queryOptions({
    queryKey: changeKeys.hob(hobId),
    ...followsEvents,
    queryFn: () => call((c) => c.hobChanges.forHob({ params: { agentId: hobId } })),
  });

/** The newest changes across every hob, for Settings › Changes and the notes on Home. */
export const changesLogQuery = queryOptions({
  queryKey: changeKeys.log,
  ...followsEvents,
  queryFn: () => call((c) => c.hobChanges.log()),
});

/**
 * Reads every History and the Changes log again after a change to a hob. A read still in flight is
 * cancelled first, since it may have been taken before the change (STD-REACT-012).
 */
export const hobChangesChanged = async (queryClient: QueryClient) => {
  await queryClient.cancelQueries({ queryKey: changeKeys.all });
  await queryClient.invalidateQueries({ queryKey: changeKeys.all });
};

/** Keeps every History and the Changes log live: each hob event records a change to it. */
export const applyHobChanges = (queryClient: QueryClient, event: HobbotsEvent) => {
  if (event._tag === "AgentUpserted") void hobChangesChanged(queryClient);
};

/** Reverts the hob's latest change, `version`, as its next version made by you. */
export const useRevertChange = (hobId: AgentId) =>
  useHobChange((version: number) => call((c) => c.hobChanges.revert({ params: { agentId: hobId, version } })));

// Versioned in its key (STD-REACT-026): a later shape takes a new key and this one is dropped.
const SEEN_KEY = "hobbots.changesSeen.v1";

/** Each hob's id, with the time of the newest change you saw on its profile, an ISO time. */
const ChangesSeen = Schema.Record(Schema.String, Schema.String);

/** The stored value as ChangesSeen, or none seen when it is missing or in another shape. */
export const parseChangesSeen = (stored: unknown): Readonly<Record<string, string>> =>
  Option.getOrElse(Schema.decodeUnknownOption(ChangesSeen)(stored), () => ({}));

/**
 * When you last opened each hob's profile on this device, so its Home tile notes a change another
 * hob made only until you look (per-viewer state, kept in the browser).
 */
export const readChangesSeen = (): Readonly<Record<string, string>> =>
  parseChangesSeen(readStored<unknown>(SEEN_KEY, null));

/** Records that you saw the hob's changes up to `at`. */
export const markChangesSeen = (hobId: AgentId, at: string) => {
  const seen = readChangesSeen();
  if ((seen[hobId] ?? "") >= at) return;
  writeStored(SEEN_KEY, { ...seen, [hobId]: at });
};
