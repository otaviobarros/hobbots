// The Markdown check (STD-DUP-008): code reads Markdown only through a CommonMark parser
// (`mdast-util-from-markdown`, `micromark`, or `remark-parse` in the web app), never by hand. It
// flags what reading Markdown by hand looks like in the hub's packages and the apps:
// - a regular expression that matches a code fence, an ATX heading, a link destination, a reference
//   definition or a front matter fence,
// - a string method (`startsWith`, `includes`, `split` and the like) given one of those marks,
// - an import of another Markdown parser.
// Writing Markdown, such as `# ${title}` in an export, is not flagged. The pure parts live here so
// scripts/markdown.test.mjs can feed them text; scripts/check-markdown.mjs reads the repository.

import { parseSync, Visitor } from "oxc-parser";

/** The source files the check reads: the hub's packages and the apps, without tests and fakes in testing folders. */
export const isChecked = (file) =>
  /^(?:packages\/[^/]+|apps\/[^/]+)\/src\//.test(file) &&
  /\.(?:tsx?|mjs)$/.test(file) &&
  !/\.test\.tsx?$/.test(file) &&
  !/\/(?:test|testing)\//.test(file);

/** Markdown parsers other than the one the project uses. */
const OTHER_PARSERS = new Set(["marked", "markdown-it", "commonmark", "showdown", "snarkdown", "remarkable"]);

/** Regular expression source that reads a Markdown mark: a fence, a heading, a link target, a definition or front matter. */
const MARK_PATTERNS = [
  { what: "a code fence", test: /`{3}|~{3}/ },
  { what: "an ATX heading", test: /\^(?:\\s\*|\[ \\t\]\*| \*)?#(?:\\s|[ +{])/ },
  { what: "a link destination", test: /\\\]\\\(/ },
  { what: "a reference definition", test: /\\\]:/ },
  { what: "front matter", test: /\^(?:\\uFEFF\??|\uFEFF\??)?-{3}(?!-)/ },
];

/** A string that is a Markdown mark when a string method looks for it. */
const MARK_STRINGS = [
  { what: "a code fence", test: /^(?:`{3}|~{3})/ },
  { what: "an ATX heading", test: /^#{1,6} / },
  { what: "a link destination", test: /^\]\(/ },
  { what: "a reference definition", test: /^\]:/ },
  { what: "front matter", test: /^-{3}(?:\r?\n)?$/ },
];

const STRING_METHODS = new Set([
  "startsWith",
  "endsWith",
  "includes",
  "indexOf",
  "lastIndexOf",
  "split",
  "replace",
  "replaceAll",
]);

/** The value of a string literal or a template literal without expressions, or null. */
const stringOf = (node) => {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? null;
  return null;
};

const markIn = (marks, text) => marks.find((mark) => mark.test.test(text))?.what;

/** Each place a file reads Markdown by hand, with its line and what it reads. */
export const handReadMarkdown = (file, text) => {
  const { program } = parseSync(file, text);
  const found = [];
  const flag = (node, what) => {
    if (what !== undefined) found.push({ line: text.slice(0, node.start).split("\n").length, what });
  };
  const byPattern = (node, source) => {
    const what = source === null ? undefined : markIn(MARK_PATTERNS, source);
    flag(node, what && `reads ${what} with a regular expression`);
  };
  new Visitor({
    Literal: (node) => {
      if (node.regex) byPattern(node, node.regex.pattern);
    },
    NewExpression: (node) => {
      if (node.callee.type === "Identifier" && node.callee.name === "RegExp")
        byPattern(node, stringOf(node.arguments[0]));
    },
    CallExpression: (node) => {
      const method = node.callee.type === "MemberExpression" ? node.callee.property.name : undefined;
      const value = STRING_METHODS.has(method) ? stringOf(node.arguments[0]) : null;
      const what = value === null ? undefined : markIn(MARK_STRINGS, value);
      flag(node, what && `reads ${what} with ${method}`);
    },
    ImportDeclaration: (node) => {
      flag(node, OTHER_PARSERS.has(node.source.value) ? `imports ${node.source.value}` : undefined);
    },
  }).visit(program);
  return found.sort((a, b) => a.line - b.line);
};

/** One error for each place a checked file reads Markdown by hand. */
export const check = (files, read) =>
  files
    .filter(isChecked)
    .flatMap((file) =>
      handReadMarkdown(file, read(file)).map(
        ({ line, what }) =>
          `${file}:${line} ${what}. Read Markdown with the CommonMark parser instead (mdast-util-from-markdown, or remark-parse in apps/web), STD-DUP-008.`,
      ),
    );
