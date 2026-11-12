import {
  type Actor,
  type AgentId,
  type FindResult,
  type FoundMessage,
  type FoundRecord,
  isCrossedOut,
  type MessageId,
  type RegisteredArtifactKind,
  type SnippetPart,
  type ThreadId,
} from "@hobbots/domain";

// What Find shows (ADR 037, #1386): what matched, grouped by kind in the design's order, each row
// with its glyph, its words, who and when, and where it opens. Pure, so it is tested without React.

/** The groups Find shows, in order. */
export type FindGroupKind = "decision" | "artifact" | "chapter" | "message";

/** Where picking a row or a citation goes: its chat or camp, at the message it came from when it has one. */
interface FindTarget {
  readonly hobId: AgentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId | null;
}

/** One row of Find's results. */
export interface FindRow {
  readonly key: string;
  readonly kind: FindGroupKind;
  /** The glyph in the row's tile: `code` for code, `file` for every other artifact. */
  readonly glyph: "decision" | "code" | "file" | "chapter" | "message";
  /** The decision, the artifact's title, the chapter's title, or the message's words around the match. */
  readonly title: ReadonlyArray<SnippetPart>;
  /** A decision that no longer holds, shown crossed out. */
  readonly crossedOut: boolean;
  /** Who made it; null for a chapter. */
  readonly actor: Actor | null;
  readonly at: string;
  /** The chat or camp it is in, named only when Find looks everywhere. */
  readonly where: string | null;
  /** An artifact's kind and version. */
  readonly artifact: { readonly kind: RegisteredArtifactKind; readonly version: number } | null;
  /** A chapter's number. */
  readonly chapterNumber: number | null;
  readonly target: FindTarget;
}

export interface FindGroup {
  readonly kind: FindGroupKind;
  readonly rows: ReadonlyArray<FindRow>;
}

const ORDER: ReadonlyArray<FindGroupKind> = ["decision", "artifact", "chapter", "message"];

const plain = (text: string): ReadonlyArray<SnippetPart> => [{ text, match: false }];

const targetOf = (found: FoundRecord | FoundMessage): FindTarget => ({
  hobId: found.hobId,
  threadId: found.threadId,
  messageId: found.messageId,
});

/** A record or a message as a row; `everywhere` names its chat or camp. */
export const rowOf = (found: FoundRecord | FoundMessage, everywhere: boolean): FindRow => {
  const base = {
    key: `${found._tag}:${found._tag === "message" ? found.messageId : found.id}`,
    kind: found._tag,
    crossedOut: false,
    actor: null,
    at: found.at,
    where: everywhere ? found.threadTitle : null,
    artifact: null,
    chapterNumber: null,
    target: targetOf(found),
  } as const;
  switch (found._tag) {
    case "decision":
      return { ...base, glyph: "decision", title: found.snippet, crossedOut: isCrossedOut(found), actor: found.actor };
    case "artifact":
      return {
        ...base,
        glyph: found.kind === "code" ? "code" : "file",
        title: plain(found.title),
        actor: found.actor,
        artifact: { kind: found.kind, version: found.version },
      };
    case "chapter":
      return { ...base, glyph: "chapter", title: found.snippet, chapterNumber: found.number };
    case "message":
      return { ...base, glyph: "message", title: found.snippet, actor: found.actor };
  }
};

/** What Find found, grouped by kind in order, empty groups left out. */
export const findGroups = (found: FindResult, everywhere: boolean): ReadonlyArray<FindGroup> => {
  const rows = [...found.records, ...found.messages].map((each) => rowOf(each, everywhere));
  return ORDER.map((kind) => ({ kind, rows: rows.filter((row) => row.kind === kind) })).filter(
    (group) => group.rows.length > 0,
  );
};

/** Whether Find found nothing at all. */
export const foundNothing = (found: FindResult) => found.records.length === 0 && found.messages.length === 0;
