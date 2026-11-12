import type { AskWithoutAnswer, RegisteredArtifactKind, ThreadKind } from "@hobbots/domain";
import { formatCount, plural } from "../../lib/format.ts";
import type { FindGroupKind } from "./find-model.ts";

interface Named {
  readonly name: string;
}

/** User-facing copy for Find and Ask in a chat or camp (STD-I18N-001). */
export const messages = {
  open: "Find",
  label: "Find",
  placeholder: "Find a decision, a file, or anything said",
  close: "Close Find",
  clear: "Clear the search",
  results: "What Find found",
  scope: "Where to look",
  here: ({ kind }: { readonly kind: ThreadKind }) => (kind === "camp" ? "This camp" : "This chat"),
  everywhere: "Everywhere",
  group: ({ kind, count }: { readonly kind: FindGroupKind; readonly count: number }) =>
    `${{ decision: "Decisions", artifact: "Artifacts", chapter: "Chapters", message: "Messages" }[kind]} · ${formatCount(count)}`,
  searching: "Looking…",
  failed: "Find couldn't reach the hub. Check the connection and type again.",
  nothing: ({ name }: Named) => `No exact matches. Ask ${name}: the records may still answer it.`,
  ask: ({ name, question }: Named & { readonly question: string }) => `Ask ${name}: “${question}”`,
  askKey: "Enter",
  asking: ({ name }: Named) => `${name} is reading the records…`,
  answerBy: ({ name }: Named) => `${name} · from the records, nothing new was run`,
  sources: "Sources",
  without: ({ reason, name }: Named & { readonly reason: AskWithoutAnswer }) =>
    ({
      "no-ai": "No AI is chosen for the hub's brain, so here is what matches, with no answer.",
      "no-answer": `${name} couldn't answer that from the records. Here is what matches.`,
      "nothing-found": "No decision, artifact or chapter mentions that. Try other words, or look everywhere.",
    })[reason],
  askFailed: "Ask couldn't reach the hub. Your question is still here: try again.",
  tryAgain: "Try again",
  you: "You",
  hub: "Hobbots",
  crossedOut: "Crossed out",
  row: {
    decision: ({ who, when }: { readonly who: string; readonly when: string }) => `Decision · ${who} · ${when}`,
    artifact: ({
      kind,
      version,
      who,
    }: {
      readonly kind: RegisteredArtifactKind;
      readonly version: number;
      readonly who: string;
    }) => `${artifactKinds[kind]} · version ${formatCount(version)} · ${who}`,
    chapter: ({ number, when }: { readonly number: number; readonly when: string }) =>
      `Chapter ${formatCount(number)} · ${when}`,
    message: ({ who, when }: { readonly who: string; readonly when: string }) => `Message · ${who} · ${when}`,
    in: ({ line, where }: { readonly line: string; readonly where: string }) => `${line} · ${where}`,
  },
  cite: ({ kind, when }: { readonly kind: FindGroupKind; readonly when: string }) =>
    `${when} · ${{ decision: "decision", artifact: "artifact", chapter: "chapter", message: "message" }[kind]}`,
  count: ({ count }: { readonly count: number }) =>
    plural(count, { one: "1 match", other: `${formatCount(count)} matches` }),
} as const;

const artifactKinds: Record<RegisteredArtifactKind, string> = {
  code: "Code",
  page: "Page",
  doc: "Doc",
  email: "Email",
  image: "Image",
  pr: "Pull request",
  file: "File",
};
