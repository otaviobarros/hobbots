import { fromMarkdown } from "mdast-util-from-markdown";

/**
 * The text of a page's first `# ` heading as it is written, its Markdown kept, or undefined when it
 * has none. A CommonMark parser finds it (STD-DUP-008): only a heading of the page itself counts, not
 * one in a quote, a list or a code block. Its text is cut from the page, as the engine keeps a title,
 * so a title saved back with its page loses no link or emphasis.
 */
// jscpd:ignore-start: apps/web reads a heading the same way, and the web app may not import this package (STD-ARCH-001).
export const pageHeading = (markdown: string): string | undefined => {
  const heading = fromMarkdown(markdown).children.find((node) => node.type === "heading" && node.depth === 1);
  const text = heading?.type === "heading" ? heading.children : [];
  const from = text[0]?.position?.start.offset;
  const to = text.at(-1)?.position?.end.offset;
  return from === undefined || to === undefined ? undefined : markdown.slice(from, to).trim() || undefined;
};
// jscpd:ignore-end
