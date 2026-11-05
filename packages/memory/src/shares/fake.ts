import { MemoryShareLog } from "@hobbots/agents";
import { EVENT_SCHEMA_VERSIONS, EventEnvelope, type JournaledEvent, type MemoryShare } from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";

/**
 * The record of memory shares, kept in the process, for tests of sharing on the fake runtime. It
 * journals as the SQL record does, numbering its own entries.
 */
export const makeMemoryShareLogFake = () => {
  const shares: Array<MemoryShare> = [];
  const journaled: Array<EventEnvelope> = [];
  let sequence = 0;
  const journal = (payload: JournaledEvent & { readonly share: MemoryShare }) => {
    sequence += 1;
    const envelope = new EventEnvelope({
      id: `memory-share-${sequence}`,
      sequence,
      schemaVersion: EVENT_SCHEMA_VERSIONS[payload._tag],
      type: payload._tag,
      occurredAt: payload.share.updatedAt,
      correlation: {
        agentId: payload.share.agentId,
        threadId: payload.share.threadId,
        messageId: payload.share.messageId,
      },
      causationId: null,
      payload,
    });
    journaled.push(envelope);
    return envelope;
  };
  const service = MemoryShareLog.of({
    begin: (share, also) =>
      Effect.sync(() => {
        const existing = shares.find(
          (stored) =>
            stored.agentId === share.agentId &&
            stored.key === share.key &&
            (stored.work === share.work || stored.work === also),
        );
        if (existing !== undefined) return { _tag: "Existing", share: existing } as const;
        shares.push(share);
        return { _tag: "Started", entries: [journal({ _tag: "MemoryShareRequested", share })] } as const;
      }),
    move: (share, from) =>
      Effect.sync(() => {
        const index = shares.findIndex((stored) => stored.id === share.id);
        const stored = shares[index];
        if (stored === undefined || !from.includes(stored.state)) return Option.none();
        shares[index] = share;
        return Option.some({ value: share, entries: [journal({ _tag: "MemoryShareChanged", share })] });
      }),
    get: (id) => Effect.sync(() => Option.fromNullishOr(shares.find((share) => share.id === id))),
    list: (decided) =>
      Effect.sync(() => {
        const open = shares.filter((share) => share.state === "waiting" || share.state === "sending");
        const closed = shares
          .filter((share) => !open.includes(share))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, decided);
        return [...open.sort((a, b) => a.createdAt.localeCompare(b.createdAt)), ...closed];
      }),
  });
  return { service, shares: () => [...shares], journaled: () => [...journaled] };
};

export const MemoryShareLogFake = Layer.sync(MemoryShareLog, () => makeMemoryShareLogFake().service);
