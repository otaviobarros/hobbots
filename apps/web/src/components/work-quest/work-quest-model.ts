import type { Actor, Agent, AgentId, MessageId, PackRead, User } from "@hobbots/domain";
import { type MemorySearch, memorySearchOf, scopeName } from "../memory/memory-model.ts";
import { messages } from "./messages.ts";

/** Where a "Read first" chip opens: a page in Memory, or the message a record was made in. */
type ReadFirstOpens =
  | { readonly _tag: "Memory"; readonly search: MemorySearch }
  | { readonly _tag: "Message"; readonly messageId: MessageId };

/** One "Read first" chip on a Quest's card, and where it opens, or null when nothing is left to open. */
export interface ReadFirstChip {
  readonly key: string;
  readonly label: string;
  readonly opens: ReadFirstOpens | null;
}

/** The jump to a message, only while it is in the transcript shown: one moved elsewhere opens nothing here. */
const atMessage = (messageId: MessageId | null, here: ReadonlySet<MessageId>): ReadFirstOpens | null =>
  messageId !== null && here.has(messageId) ? { _tag: "Message", messageId } : null;

/** A record's chip: its label and where it opens. */
const chipOf = (
  each: PackRead,
  hobs: ReadonlyMap<AgentId, Agent>,
  here: ReadonlySet<MessageId>,
): Omit<ReadFirstChip, "key"> => {
  switch (each._tag) {
    case "MemoryPage": {
      const owner = scopeName(each.scope, hobs);
      return {
        label: messages.readFirst.memory({
          where: each.scope._tag === "Hob" ? messages.readFirst.hobMemory({ hob: owner }) : owner,
          title: each.title,
        }),
        opens: {
          _tag: "Memory",
          search: memorySearchOf({ _tag: "Page", scope: each.scope, path: each.path, version: null }),
        },
      };
    }
    case "Decision":
      return { label: messages.readFirst.decision({ title: each.title }), opens: atMessage(each.messageId, here) };
    case "Artifact":
      return {
        label: messages.readFirst.artifact({ title: each.title, version: each.version }),
        opens: atMessage(each.messageId, here),
      };
    case "Chapter":
      return {
        label: messages.readFirst.chapter({ number: each.number, title: each.title }),
        opens: atMessage(each.messageId, here),
      };
  }
};

/**
 * The chips a Quest's card lists as "Read first" (ADR 039), in the order its owner's pack carried
 * them: memory pages open in Memory, and decisions, artifacts and chapters at the message they were
 * made in, when that message is in the transcript shown (`here`), as it is not once its chapter moved. They come from the pack's report, so no model is asked.
 */
export const readFirstChips = (
  read: ReadonlyArray<PackRead>,
  hobs: ReadonlyMap<AgentId, Agent>,
  here: ReadonlySet<MessageId>,
): ReadonlyArray<ReadFirstChip> =>
  read.map((each, index) => ({ key: `${index}:${each._tag}`, ...chipOf(each, hobs, here) }));

/**
 * Who the card says asked for the Quest: "you", a person's or a hob's name. Null when its owner
 * started it on its own, or when the asker is not known to this client, so the card never shows an id.
 */
export const requesterName = ({
  requestedBy,
  owner,
  you,
  people,
  hobs,
}: {
  readonly requestedBy: Actor;
  readonly owner: AgentId;
  readonly you: User | undefined;
  readonly people: ReadonlyArray<User>;
  readonly hobs: ReadonlyMap<AgentId, Agent>;
}): string | null => {
  switch (requestedBy.kind) {
    case "hob":
      return requestedBy.id === owner ? null : (hobs.get(requestedBy.id as AgentId)?.name ?? null);
    case "user":
      if (requestedBy.id === you?.id) return messages.you;
      return people.find((person) => person.id === requestedBy.id)?.name ?? null;
    default:
      return null;
  }
};
