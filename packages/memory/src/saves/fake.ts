import { MemorySaves } from "@hobbots/agents";
import { EVENT_SCHEMA_VERSIONS, EventEnvelope, type JournaledEvent, MemorySave } from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";

/**
 * The record of memory saves, kept in the process, for tests of the memory tools on the fake
 * runtime. It journals as the SQL record does, numbering its own entries.
 */
export const makeMemorySavesFake = () => {
  const saves: Array<MemorySave> = [];
  const journaled: Array<EventEnvelope> = [];
  let sequence = 0;
  const journal = (payload: JournaledEvent & { readonly save: MemorySave }) => {
    sequence += 1;
    const envelope = new EventEnvelope({
      id: `memory-save-${sequence}`,
      sequence,
      schemaVersion: EVENT_SCHEMA_VERSIONS[payload._tag],
      type: payload._tag,
      occurredAt: payload.save.updatedAt,
      correlation: {
        agentId: payload.save.agentId,
        threadId: payload.save.threadId,
        messageId: payload.save.messageId,
      },
      causationId: null,
      payload,
    });
    journaled.push(envelope);
    return envelope;
  };
  const service = MemorySaves.of({
    begin: (save, also) =>
      Effect.sync(() => {
        const existing = saves.find(
          (stored) =>
            stored.agentId === save.agentId &&
            stored.key === save.key &&
            (stored.work === save.work || stored.work === also),
        );
        if (existing !== undefined) return { _tag: "Existing", save: existing } as const;
        saves.push(save);
        return { _tag: "Started", entries: [journal({ _tag: "MemorySaveRecorded", save })] } as const;
      }),
    settle: (save, state, version, at) =>
      Effect.sync(() => {
        const index = saves.findIndex((stored) => stored.id === save.id);
        const stored = saves[index];
        if (stored === undefined || (stored.state !== "sending" && stored.state !== "queued")) return Option.none();
        const settled = new MemorySave({ ...stored, state, version, updatedAt: at });
        saves[index] = settled;
        return Option.some({ value: settled, entries: [journal({ _tag: "MemorySaveChanged", save: settled })] });
      }),
    unsent: Effect.sync(() => saves.filter((save) => save.state === "sending" || save.state === "queued")),
  });
  return { service, saves: () => [...saves], journaled: () => [...journaled] };
};

export const MemorySavesFake = Layer.sync(MemorySaves, () => makeMemorySavesFake().service);
