// The glossary check (STD-DOCS-011): the words the UI shows and the names the code gives them stay as
// the "Words and code names" table of docs/product/glossary.md says. A row fails when its code name
// is exported nowhere, when no message module uses its UI word, when a message module's copy uses a
// word the UI never shows, or when a doc uses a word the docs no longer use.
//
// Copy is every string and template literal of a message module (STD-I18N-001), except object keys,
// codes such as "thread-closed", and paths such as "~/.agents/skills". The pure parts live here so
// scripts/glossary.test.mjs can feed them text; scripts/check-glossary.mjs reads the repository.

import { parseSync, visitorKeys } from "oxc-parser";

const RULE = "STD-DOCS-011";
const HEADING = "## Words and code names";

/** The words in backticks of a cell, and the quoted phrases after "except" that may still use them. */
const wordsOf = (cell) => {
  const [words, except = ""] = cell.split(/\bexcept\b/);
  return {
    words: [...words.matchAll(/`([^`]+)`/g)].map((match) => match[1].toLowerCase()),
    except: [...except.matchAll(/"([^"]+)"/g)].map((match) => match[1].toLowerCase()),
  };
};

/**
 * The rows of the glossary's "Words and code names" table: the UI words (none for "(not shown)"), the
 * code name, and the words the UI and the docs never use, each with the phrases that still may.
 */
export const parseGlossary = (markdown) => {
  const start = markdown.indexOf(HEADING);
  if (start === -1) throw new Error(`docs/product/glossary.md has no "${HEADING}" section`);
  const lines = markdown.slice(start).split("\n").slice(1);
  const table = lines.slice(lines.findIndex((line) => line.startsWith("|")));
  const end = table.findIndex((line) => !line.startsWith("|"));
  // The header and its separator, then one row per term.
  return table.slice(2, end === -1 ? table.length : end).map((line) => {
    const [ui, code, never, docs] = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const name = code.match(/`([^`]+)`/)?.[1];
    if (name === undefined) throw new Error(`The glossary row "${line}" names no code in backticks`);
    return {
      ui: ui.startsWith("(") ? [] : ui.split(",").map((word) => word.trim().toLowerCase()),
      code: name,
      never: { ui: wordsOf(never ?? ""), docs: wordsOf(docs ?? "") },
    };
  });
};

const KEBAB_CODE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
/** A path or module specifier, such as "~/.agents/skills" or "./model.ts": one word, starting like a path. */
const PATH = /^[~./@]\S*$/;

/** Whether a literal is copy someone reads, not a code or a path. */
const isCopy = (text) => text.trim() !== "" && !KEBAB_CODE.test(text) && !PATH.test(text.trim());

/** Nodes that are only types. */
const TYPES = new Set(["TSTypeAliasDeclaration", "TSInterfaceDeclaration", "TSModuleDeclaration", "TSEnumDeclaration"]);
/** The children of a node that are only types. */
const TYPE_KEYS = new Set(["typeAnnotation", "typeArguments", "typeParameters", "returnType", "superTypeArguments"]);

/** The text a node holds as copy: a string literal that is no object key, or a template's text. */
const textOf = (node, parent, key) => {
  const isKey = key === "key" && (parent?.type === "Property" || parent?.type === "TSPropertySignature");
  const text =
    node.type === "Literal" && typeof node.value === "string" && !isKey
      ? node.value
      : node.type === "TemplateElement"
        ? (node.value.cooked ?? node.value.raw)
        : undefined;
  return text !== undefined && isCopy(text) ? text : undefined;
};

/** Whether a node holds no copy: types and imports. An expression inside `as const` or `satisfies` does. */
const holdsNoCopy = (node) =>
  TYPES.has(node.type) || node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration";

/** Every piece of copy in a message module, with its line: string literals and template text, never keys. */
export const copyOf = (file, text) => {
  const { program } = parseSync(file, text);
  const lineAt = (offset) => text.slice(0, offset).split("\n").length;
  const found = [];
  const visit = (node, parent, key) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent, key);
      return;
    }
    const copy = textOf(node, parent, key);
    if (copy !== undefined) found.push({ line: lineAt(node.start), text: copy });
    if (holdsNoCopy(node)) return;
    for (const child of visitorKeys[node.type] ?? []) if (!TYPE_KEYS.has(child)) visit(node[child], node, child);
  };
  visit(program, null, null);
  return found;
};

const escaped = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A word as a whole word, singular or plural, in any case. */
const wordPattern = (word) => new RegExp(`\\b${escaped(word)}s?\\b`, "i");

/** Whether `text` uses `word` outside the phrases that still may. */
const uses = (text, word, except) => {
  let rest = text.toLowerCase();
  for (const phrase of except) rest = rest.replaceAll(phrase, " ");
  return wordPattern(word).test(rest);
};

/** The places a message module's copy uses a word the UI never shows. */
export const checkCopy = (file, copy, rows) =>
  rows.flatMap((row) =>
    row.never.ui.words.flatMap((word) =>
      copy
        .filter((piece) => uses(piece.text, word, row.never.ui.except))
        .map(
          (piece) =>
            `${file}:${piece.line}: the UI never says "${word}", which the code calls ${row.code}: say ${row.ui.length > 0 ? row.ui.map((each) => `"${each}"`).join(" or ") : "what the glossary says"} (${RULE})`,
        ),
    ),
  );

/** Markdown without its code: fences and inline code may name anything. */
const prose = (markdown) =>
  markdown.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, " ")).replace(/`[^`\n]*`/g, " ");

/** The places a doc uses a word the docs no longer use. */
export const checkDoc = (file, markdown, rows) => {
  const lines = prose(markdown).split("\n");
  return rows.flatMap((row) =>
    row.never.docs.words.flatMap((word) =>
      lines.flatMap((line, index) =>
        uses(line, word, row.never.docs.except)
          ? [`${file}:${index + 1}: the docs say ${row.code}, never "${word}" (${RULE})`]
          : [],
      ),
    ),
  );
};

/**
 * What the table names that no longer exists: a code name no source exports, and a UI word no copy
 * uses. `exported` holds every name exported from the packages and the server; `copy` every piece of
 * copy of every message module.
 */
export const checkTable = (rows, exported, copy) =>
  rows.flatMap((row) => [
    ...(exported.has(row.code)
      ? []
      : [`docs/product/glossary.md: ${row.code} is exported from no package or the server any more (${RULE})`]),
    ...row.ui
      .filter((word) => !copy.some((piece) => wordPattern(word).test(piece.text)))
      .map((word) => `docs/product/glossary.md: no message module says "${word}" any more (${RULE})`),
  ]);

/** The names a module exports: classes, functions, constants, types and interfaces. */
export const exportsOf = (text) =>
  [
    ...text.matchAll(
      /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|const|let|function|type|interface)\s+([A-Za-z_$][\w$]*)/gm,
    ),
  ].map((match) => match[1]);
