import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { checkCopy, checkDoc, checkTable, copyOf, exportsOf, parseGlossary } from "./glossary.mjs";

const GLOSSARY = `# Glossary

| Term | Meaning | Owner |
|---|---|---|
| Thread | A conversation. | x |

## Words and code names

Some words.

| UI | Code | Never in the UI | Never in the docs |
| --- | --- | --- | --- |
| hob | \`Agent\` | | |
| chat, camp | \`Thread\` | \`thread\` | |
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
      [["chat", "camp"], "Thread"],
      [[], "Attempt"],
    ],
  );
  assert.deepEqual(rows[2].never.docs, { words: ["execution"], except: ["execution environment", "execution rules"] });
  assert.deepEqual(rows[1].never.ui, { words: ["thread"], except: [] });
});

// covers #1423
test("[TC-GEN-1423-01] a code name no source exports any more fails", () => {
  const problems = checkTable(
    rows,
    new Set(["Agent", "Thread"]),
    copy(`export const m = { a: "Ask a hob in a chat or camp" };`),
  );
  assert.deepEqual(problems, [
    "docs/product/glossary.md: Attempt is exported from no package or the server any more (STD-DOCS-011)",
  ]);
});

test("[TC-GEN-1423-02] a UI word no message module uses any more fails", () => {
  const problems = checkTable(
    rows,
    new Set(["Agent", "Thread", "Attempt"]),
    copy(`export const m = { a: "Ask a hob in a chat" };`),
  );
  assert.deepEqual(problems, ['docs/product/glossary.md: no message module says "camp" any more (STD-DOCS-011)']);
});

test("[TC-GEN-1423-03] copy that says a word the UI never shows fails, with its line", () => {
  const text = `export const m = {\n  title: "Chats",\n  open: ({ n }: { n: number }) => \`Open \${n} threads\`,\n};`;
  assert.deepEqual(checkCopy("m.ts", copy(text), rows), [
    'm.ts:3: the UI never says "thread", which the code calls Thread: say "chat" or "camp" (STD-DOCS-011)',
  ]);
});

test("keys, codes, paths, types and imports are not copy", () => {
  const text = [
    'import { thread } from "./thread.ts";',
    "type Thread = { thread: string };",
    'export const m = { thread: "Chat", "thread-closed": "Closed", code: "same-thread", path: "~/thread/x" } as const;',
  ].join("\n");
  assert.deepEqual(checkCopy("m.ts", copy(text), rows), []);
  assert.deepEqual(
    copy(text).map((piece) => piece.text),
    ["Chat", "Closed"],
  );
});

test("[TC-GEN-1423-04] a doc that uses a retired word fails, except in its phrases and in code", () => {
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
  const text = "export class Agent {}\nexport const Thread = 1;\nexport type Attempt = string;\nconst Hidden = 2;";
  assert.deepEqual(exportsOf(text), ["Agent", "Thread", "Attempt"]);
});

test("a glossary without the table is refused", () => {
  assert.throws(() => parseGlossary("# Glossary\n"), /no "## Words and code names" section/);
});

test("[TC-GEN-1423-05] the repository's UI, code and docs agree with its glossary", () => {
  const out = execFileSync("node", ["scripts/check-glossary.mjs"], { encoding: "utf8" });
  assert.match(out, /^Glossary check passed/);
});
