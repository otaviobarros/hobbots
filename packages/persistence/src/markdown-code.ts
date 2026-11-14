import type { TextRange } from "@hobbots/domain";
import { fromMarkdown } from "mdast-util-from-markdown";

// Where a message's Markdown code is, so a mention written in it mentions nobody (ADR 039, Who
// answers). The text is read by a CommonMark parser, never by hand: fenced and indented code blocks,
// in quotes and list items at any depth, and code spans, exactly as the spec defines them.

interface Node {
  readonly type: string;
  readonly position?:
    | {
        readonly start: { readonly offset?: number | undefined };
        readonly end: { readonly offset?: number | undefined };
      }
    | undefined;
  readonly children?: ReadonlyArray<Node> | undefined;
}

/** The text's code blocks and code spans, by UTF-16 offsets, in the order they appear. */
export const markdownCode = (text: string): ReadonlyArray<TextRange> => {
  if (!text.includes("@")) return [];
  const ranges: Array<TextRange> = [];
  const pending: Array<Node> = [fromMarkdown(text)];
  while (pending.length > 0) {
    const node = pending.pop();
    const { start, end } = node?.position ?? {};
    if (
      (node?.type === "code" || node?.type === "inlineCode") &&
      start?.offset !== undefined &&
      end?.offset !== undefined
    ) {
      ranges.push({ from: start.offset, to: end.offset });
    } else {
      pending.push(...(node?.children ?? []));
    }
  }
  return ranges.sort((a, b) => a.from - b.from);
};
