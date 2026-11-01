import remarkParse from "remark-parse";
import remend from "remend";
import { unified } from "unified";

// A table's delimiter row, such as `| --- | :-: |` or `--- | ---`: only pipes, dashes, colons and spaces.
const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
// The start of a delimiter row still arriving, such as `  `, `-` or `--- | :-`, after any quote marks.
const DELIMITER_START = /^[\s|:-]*$/;
// A table may sit inside a quote, so its rows can start with `>`.
const unquoted = (line: string) => line.replace(/^\s*(>\s?)*/, "");
// A row of a table, with or without outer pipes, holds a pipe.
const isTableLine = (line: string) => unquoted(line).includes("|");

/** The parts of a Markdown syntax tree (mdast) node needed to find its code blocks. */
interface MdNode {
  readonly type: string;
  readonly position?:
    | { readonly start: { readonly line: number }; readonly end: { readonly line: number } }
    | undefined;
  readonly children?: ReadonlyArray<MdNode>;
}

const parser = unified().use(remarkParse);

/**
 * The lines, counted from 0, that belong to a code block, as the Markdown parser reads them: fenced
 * or indented, inside quotes and list items, and still open at the end of the text.
 */
const codeLines = (text: string): ReadonlySet<number> => {
  const lines = new Set<number>();
  const visit = (node: MdNode) => {
    if (node.type === "code" && node.position) {
      for (let line = node.position.start.line; line <= node.position.end.line; line += 1) lines.add(line - 1);
    }
    node.children?.forEach(visit);
  };
  visit(parser.parse(text));
  return lines;
};

/**
 * Holds back a table that is still arriving, so it never shows as a line of pipes first. A row
 * still being written waits for its line break, and a header waits for the row of dashes that makes
 * it a table. Text inside a code block is never held back.
 */
export const holdBackPartialTable = (text: string): string => {
  const lines = text.split("\n");
  const code = codeLines(text);
  const tableLine = (index: number) => !code.has(index) && isTableLine(lines[index] ?? "");
  const last = lines.length - 1;
  const partial = lines[last] ?? "";
  // A row still being written waits, and so does the start of a delimiter row under a table line,
  // such as `---` before its `| ---` arrives.
  const delimiterStarting = !code.has(last) && DELIMITER_START.test(unquoted(partial)) && tableLine(last - 1);
  if (tableLine(last) || delimiterStarting) lines[last] = "";

  // The table lines just before the end, if any, and whether they are still only a header.
  const end = lines[last] === "" ? last : lines.length;
  let start = end;
  while (start > 0 && tableLine(start - 1)) start -= 1;
  const block = lines.slice(start, end);
  if (block.length > 0 && !block.some((line) => DELIMITER_ROW.test(unquoted(line)))) lines.splice(start, end - start);
  return lines.join("\n");
};

/**
 * The Markdown to show for a reply that is still in progress: an unfinished table is held back, and
 * unclosed emphasis, inline code and links are closed for now, so the text does not jump between
 * raw and formatted as words arrive. A reply that has ended is shown exactly as written.
 */
export const streamingMarkdown = (text: string): string =>
  remend(holdBackPartialTable(text), { katex: false, linkMode: "text-only" });
