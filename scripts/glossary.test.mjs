import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { checkCopy, checkDoc, checkTable, copyOf, exportsOf, parseGlossary } from "./glossary.mjs";

const GLOSSARY = `# Glossary

| Term | Meaning | Owner |
|---|---|---|
| Channel | A conversation. | x |

## Words and code names

Some words.

| UI | Code | Never in the UI | Never in the docs |
| --- | --- | --- | --- |
| hob | \`Agent\` | | |
| chat, camp | \`Channel\` | \`channel\` | |
| (not shown) | \`Attempt\` | \`execution\` | \`execution\` except "execution environment", "execution rules" |

## After
`;

const rows = parseGlossary(GLOSSARY);
const copy = (text) => copyOf("messages.ts", text);

test("reads the table's UI words, code names and the words each never uses", () => {
  assert.deepEqual(
    rows.map((row) => [row.ui, row.code]),
    [
      [["hob"], "Agent"],
      [["chat", "camp"], "Channel"],
      [[], "Attempt"],
    ],
  );
  assert.deepEqual(rows[2].never.docs, { words: ["execution"], except: ["execution environment", "execution rules"] });
  assert.deepEqual(rows[1].never.ui, { words: ["channel"], except: [] });
});

// covers #1423
test("a code name no source exports any more fails (#1423)", () => {
  const problems = checkTable(
    rows,
    new Set(["Agent", "Channel"]),
    copy(`export const m = { a: "Ask a hob in a chat or camp" };`),
  );
  assert.deepEqual(problems, [
    "docs/product/glossary.md: Attempt is exported from no package or the server any more (STD-DOCS-011)",
  ]);
});

test("a UI word no message module uses any more fails (#1423)", () => {
  const problems = checkTable(
    rows,
    new Set(["Agent", "Channel", "Attempt"]),
    copy(`export const m = { a: "Ask a hob in a chat" };`),
  );
  assert.deepEqual(problems, ['docs/product/glossary.md: no message module says "camp" any more (STD-DOCS-011)']);
});

test("copy that says a word the UI never shows fails, with its line (#1423)", () => {
  const text = `export const m = {\n  title: "Chats",\n  open: ({ n }: { n: number }) => \`Open \${n} channels\`,\n};`;
  assert.deepEqual(checkCopy("m.ts", copy(text), rows), [
    'm.ts:3: the UI never says "channel", which the code calls Channel: say "chat" or "camp" (STD-DOCS-011)',
  ]);
});

test("copy with a slash in it is still copy, in a string and in a template (#1423)", () => {
  const text = [
    "export const m = {",
    '  open: "Open this channel/camp",',
    "  move: ({ n }: { n: number }) => `Move ${n} to another channel/camp`,",
    "};",
  ].join("\n");
  assert.deepEqual(
    checkCopy("m.ts", copy(text), rows).map((problem) => problem.split(":").slice(0, 2).join(":")),
    ["m.ts:2", "m.ts:3"],
  );
});

test("keys, codes, paths, types and imports are not copy", () => {
  const text = [
    'import { channel } from "./channel.ts";',
    "type Channel = { channel: string };",
    'export const m = { channel: "Chat", "channel-closed": "Closed", code: "same-channel", path: "~/channel/x" } as const;',
  ].join("\n");
  assert.deepEqual(checkCopy("m.ts", copy(text), rows), []);
  assert.deepEqual(
    copy(text).map((piece) => piece.text),
    ["Chat", "Closed"],
  );
});

test("a doc that uses a retired word fails, except in its phrases and in code (#1423)", () => {
  const doc = [
    "# Attempts",
    "Each execution is retried.",
    "It runs in the hub's execution environment, under Codex's execution rules.",
    "The `execution` package and",
    "```",
    "execution",
    "```",
  ].join("\n");
  assert.deepEqual(checkDoc("d.md", doc, rows), ['d.md:2: the docs say Attempt, never "execution" (STD-DOCS-011)']);
});

test("finds the names a module exports", () => {
  const text = "export class Agent {}\nexport const Channel = 1;\nexport type Attempt = string;\nconst Hidden = 2;";
  assert.deepEqual(exportsOf(text), ["Agent", "Channel", "Attempt"]);
});

test("a glossary without the table is refused", () => {
  assert.throws(() => parseGlossary("# Glossary\n"), /no "## Words and code names" section/);
});

test("the repository's UI, code and docs agree with its glossary (#1423)", () => {
  const out = execFileSync("node", ["scripts/check-glossary.mjs"], { encoding: "utf8" });
  assert.match(out, /^Glossary check passed/);
});
