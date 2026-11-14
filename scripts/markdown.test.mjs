import assert from "node:assert/strict";
import { test } from "node:test";
import { check, handReadMarkdown, isChecked } from "./markdown.mjs";

const whats = (text) => handReadMarkdown("a.ts", text).map(({ line, what }) => `${line} ${what}`);

test("finds fences, headings, link targets, definitions and front matter read by hand", () => {
  const text = [
    'if (line.startsWith("```")) open();',
    "const fence = line.startsWith(`~~~`);",
    "const title = /^#\\s+(.+)$/m.exec(page);",
    "const heading = /^\\s*#{1,6} /;",
    'const isTitle = line.startsWith("# ");',
    "const links = /\\]\\(\\s*<?([^)\\s>]+)>?/g;",
    "const definition = /^\\[[^\\]]+\\]:[ \\t]*(\\S+)/;",
    "const front = /^\\uFEFF?---\\r?\\n([\\s\\S]*?)\\r?\\n---/;",
    'const made = new RegExp("^---\\n");',
    'import { marked } from "marked";',
  ].join("\n");
  assert.deepEqual(whats(text), [
    "1 reads a code fence with startsWith",
    "2 reads a code fence with startsWith",
    "3 reads an ATX heading with a regular expression",
    "4 reads an ATX heading with a regular expression",
    "5 reads an ATX heading with startsWith",
    "6 reads a link destination with a regular expression",
    "7 reads a reference definition with a regular expression",
    "8 reads front matter with a regular expression",
    "9 reads front matter with a regular expression",
    "10 imports marked",
  ]);
});

test("leaves Markdown being written, colors, anchors, PEM blocks and comments alone", () => {
  const text = [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text of a template literal under test
    "const page = `# ${title}\\n\\n${body}`;",
    'const lines = ["  ```", ...tail, "  ```"];',
    "const HEX = /^#[0-9a-f]{6}$/i;",
    'if (target.startsWith("#")) return null;',
    "const pem = /^-----BEGIN PRIVATE KEY-----/;",
    '// line.startsWith("```") is how not to read a fence',
    'const rule = ["---", "", body].join("\\n");',
  ].join("\n");
  assert.deepEqual(whats(text), []);
});

test("reads the hub's and the apps' sources, not tests, fakes in testing folders or scripts", () => {
  assert.equal(isChecked("packages/skills/src/check.ts"), true);
  assert.equal(isChecked("apps/web/src/components/memory/memory-model.ts"), true);
  assert.equal(isChecked("apps/web/src/components/memory/memory-model.test.ts"), false);
  assert.equal(isChecked("packages/skills/test/markdown.test.ts"), false);
  assert.equal(isChecked("packages/runtimes/src/testing/fake.ts"), false);
  assert.equal(isChecked("scripts/markdown.mjs"), false);
});

test("fails a hand-read heading and names the rule", () => {
  const files = { "packages/domain/src/memory.ts": 'export const t = (l: string) => l.startsWith("# ");\n' };
  const errors = check(Object.keys(files), (file) => files[file]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^packages\/domain\/src\/memory\.ts:1 reads an ATX heading with startsWith\..*STD-DUP-008/);
});
