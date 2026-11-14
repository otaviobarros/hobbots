import { fromMarkdown } from "mdast-util-from-markdown";
import { toString as textOf } from "mdast-util-to-string";

/**
 * The text of a page's first `# ` heading, as a CommonMark parser reads it (STD-DUP-008), or
 * undefined when it has none. Only a heading of the page itself counts, not one in a quote, a list or
 * a code block.
 */
export const pageHeading = (markdown: string): string | undefined => {
  const heading = fromMarkdown(markdown).children.find((node) => node.type === "heading" && node.depth === 1);
  return heading === undefined ? undefined : textOf(heading).trim() || undefined;
};
