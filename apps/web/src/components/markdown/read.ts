import { toString as textOf } from "mdast-util-to-string";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

// Markdown the app reads rather than shows, read by the same CommonMark parser that renders replies,
// never by hand (STD-DUP-008).

const parser = unified().use(remarkParse).use(remarkGfm);

type Block = ReturnType<typeof parser.parse>["children"][number];

/** The page's own first `# ` heading: not one in a quote, a list or a code block. */
const titleHeading = (markdown: string) =>
  parser.parse(markdown).children.find((node) => node.type === "heading" && node.depth === 1);

/** The text of a page's first `# ` heading, or undefined when it has none. */
export const pageHeading = (markdown: string): string | undefined => {
  const heading = titleHeading(markdown);
  return heading === undefined ? undefined : textOf(heading).trim() || undefined;
};

/** A page's text without the `# ` heading it opens with, which the page shows as its title. */
export const withoutTitle = (markdown: string): string => {
  const first = parser.parse(markdown).children[0];
  const end = first?.type === "heading" && first.depth === 1 ? first.position?.end.offset : undefined;
  return (end === undefined ? markdown : markdown.slice(end)).trim();
};

/** The text blocks of a document, in order, with their marks dropped: headings, paragraphs, cells and code. */
const textBlocks = (node: Block): ReadonlyArray<string> => {
  if (node.type === "heading" || node.type === "paragraph" || node.type === "tableCell") return [textOf(node)];
  if (node.type === "code" || node.type === "html") return [node.value];
  return "children" in node ? node.children.flatMap((child) => textBlocks(child as Block)) : [];
};

/** A Markdown document's lines of text as a reader sees them, without heading marks, emphasis or link targets. */
export const markdownLines = (markdown: string): ReadonlyArray<string> =>
  parser
    .parse(markdown)
    .children.flatMap(textBlocks)
    .flatMap((text) => text.split("\n"));

/** A file such as a `SKILL.md` that may open with YAML front matter. */
const withFrontMatter = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]);

/** The text after a file's YAML front matter and that fence's line break, or the whole text when it has none. */
export const afterFrontMatter = (file: string): string => {
  const text = file.startsWith("\uFEFF") ? file.slice(1) : file;
  const first = withFrontMatter.parse(text).children[0];
  const end = first?.type === "yaml" ? first.position?.end.offset : undefined;
  if (end === undefined) return file;
  const rest = text.slice(end);
  return rest.slice(rest.startsWith("\r\n") ? 2 : /^[\n\r]/.test(rest) ? 1 : 0);
};
