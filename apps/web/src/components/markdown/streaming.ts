import remend from "remend";

// A fence line opens or closes a code block: ``` or ~~~, indented any amount inside list items.
const FENCE = /^\s*(`{3,}|~{3,})/;
// A table's delimiter row, such as `| --- | :-: |` or `--- | ---`: only pipes, dashes, colons and spaces.
const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
// A table may sit inside a quote, so its rows can start with `>`.
const unquoted = (line: string) => line.replace(/^\s*(>\s?)*/, "");
// A row of a table, with or without outer pipes, holds a pipe.
const isTableLine = (line: string) => unquoted(line).includes("|");

/**
 * Whether the text before `lines[end]` leaves a code block open. A fence closes only on the same
 * character, at least as long as the one that opened it.
 */
const insideFence = (lines: ReadonlyArray<string>, end: number) => {
  let open: string | null = null;
  for (const line of lines.slice(0, end)) {
    const fence = FENCE.exec(line)?.[1];
    if (fence === undefined) continue;
    if (open === null) open = fence;
    else if (fence[0] === open[0] && fence.length >= open.length && line.trim() === fence) open = null;
  }
  return open !== null;
};

/**
 * Holds back a table that is still arriving, so it never shows as a line of pipes first. A row
 * still being written waits for its line break, and a header waits for the row of dashes that makes
 * it a table. Text inside a code block is never held back.
 */
export const holdBackPartialTable = (text: string): string => {
  const lines = text.split("\n");
  const last = lines.length - 1;
  if (isTableLine(lines[last] ?? "") && !insideFence(lines, last)) lines[last] = "";

  // The table lines just before the end, if any, and whether they are still only a header.
  const end = lines[last] === "" ? last : lines.length;
  let start = end;
  while (start > 0 && isTableLine(lines[start - 1] ?? "")) start -= 1;
  const block = lines.slice(start, end);
  const headerOnly = block.length > 0 && !block.some((line) => DELIMITER_ROW.test(unquoted(line)));
  if (headerOnly && !insideFence(lines, start)) lines.splice(start, end - start);
  return lines.join("\n");
};

/**
 * The Markdown to show for a reply that is still in progress: an unfinished table is held back, and
 * unclosed emphasis, inline code and links are closed for now, so the text does not jump between
 * raw and formatted as words arrive. A reply that has ended is shown exactly as written.
 */
export const streamingMarkdown = (text: string): string =>
  remend(holdBackPartialTable(text), { katex: false, linkMode: "text-only" });
