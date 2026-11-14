import { type MemorySave, type MessageId, memoryKindOf, memoryTitleOf } from "@hobbots/domain";
import { ApiError } from "../../api/client.ts";
import { pageHeading } from "../markdown/read.ts";
import { messages as memoryCopy } from "../memory/messages.ts";
import { messages } from "./messages.ts";

const copy = messages;

/**
 * The saves a reply shows a line for (ADR 028, #961): those made from it, to the hob's own memory,
 * once memory has them or the hub kept them for later. One still sending or refused shows none.
 */
export const replySaves = (saves: ReadonlyArray<MemorySave> | undefined, messageId: MessageId) =>
  (saves ?? []).filter(
    (save) =>
      save.messageId === messageId && save.scope._tag === "Hob" && (save.state === "saved" || save.state === "queued"),
  );

/** What the line says, and whether it offers Open and Undo. */
export const savedLine = (save: MemorySave, name: string) => {
  const title = memoryTitleOf(save.path, pageHeading(save.markdown));
  const kind = memoryCopy.kinds[memoryKindOf(save.path)].one;
  if (save.undoneAt !== undefined) return { title, text: copy.undone({ name }), actions: false };
  if (save.state === "queued") return { title, text: copy.kept({ name, kind, title }), actions: false };
  return { title, text: copy.saved({ name, kind, title }), actions: true };
};

/** Why an Undo did not land, in the user's words. */
export const undoFailure = (error: unknown, name: string): string => {
  if (!(error instanceof ApiError)) return copy.failed.other;
  if (error.tag === "MemoryNotAnswering") return copy.failed.offline;
  if (error.tag === "MemorySaveNotUndoable") {
    const reason = error.fields.reason;
    if (reason === "newer") return copy.failed.newer({ name });
    if (reason === "undone") return copy.failed.undone;
  }
  return copy.failed.other;
};
