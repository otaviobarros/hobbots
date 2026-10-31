import assert from "node:assert/strict";
import { test } from "node:test";
import { check, measure } from "./complexity.mjs";

const complexities = (source, filename = "probe.ts") =>
  Object.fromEntries(measure(filename, source).functions.map((fn) => [fn.name, fn.complexity]));

test("a function without branches has complexity 1", () => {
  assert.deepEqual(complexities("function plain() { return 1; }"), { plain: 1 });
});

test("each branch point adds one, as in ESLint's classic variant", () => {
  const source = `
    const branches = (a, b = 1) => {           // default value: +1
      if (a) {}                                // +1
      for (;;) {}                              // +1
      for (const x of a) {}                    // +1
      for (const k in a) {}                    // +1
      while (a) {}                             // +1
      do {} while (a);                         // +1
      try {} catch {}                          // +1
      const c = a ? 1 : 2;                     // +1
      const d = (a && b || c) ?? 0;            // +3
      a ||= b;                                 // +1
      a.x = 1;                                 // plain assignment: +0
      return a?.b?.();                         // +2
    };`;
  assert.deepEqual(complexities(source), { branches: 16 });
});

test("each case counts and default does not", () => {
  const cases = Array.from({ length: 30 }, (_, i) => `case ${i}: return ${i};`).join("\n");
  const source = `function wide(n: number) { switch (n) { ${cases} default: return -1; } }`;
  assert.deepEqual(complexities(source), { wide: 31 });
});

test("nested functions are measured on their own", () => {
  const source = `
    function outer(a) {
      if (a) {}
      return [a].map(function inner(x) { return x ? 1 : 2; });
    }`;
  assert.deepEqual(complexities(source), { outer: 2, inner: 2 });
});

test("names come from variables, methods and class fields", () => {
  const source = `
    const arrow = () => 1;
    class Box {
      method() { return 1; }
      field = () => 1;
      static { if (Box) {} }
    }`;
  assert.deepEqual(complexities(source), {
    arrow: 1,
    method: 1,
    field: 1,
    "class static block": 2,
  });
});

test("JSX conditions count like any expression", () => {
  const source = "export function View({ a, b }) { return <div>{a && <b />}{b ? 1 : 2}</div>; }";
  assert.deepEqual(complexities(source, "probe.tsx"), { View: 3 });
});

const ifs = (count) => Array.from({ length: count }, (_, i) => `if (n === ${i}) return ${i};`).join("\n");

test("check reports a function above the limit", () => {
  const problems = check("probe.ts", `function big(n) {\n${ifs(3)}\n}`, 3);
  assert.deepEqual(problems, [{ line: 1, message: "big has a complexity of 4 (max 3)" }]);
});

test("a marker with a reason allows the function below it, through other comments", () => {
  const source = `// complexity-ignore: a flat dispatch table.\n/** Docs. */\n// biome-ignore lint/x: y\nfunction big(n) {\n${ifs(3)}\n}`;
  assert.deepEqual(check("probe.ts", source, 3), []);
});

test("a marker without a reason is reported", () => {
  const source = `// complexity-ignore:\nfunction big(n) {\n${ifs(3)}\n}`;
  assert.deepEqual(check("probe.ts", source, 3), [
    { line: 1, message: "complexity-ignore needs a reason after the colon" },
  ]);
});

test("a marker that allows nothing is reported", () => {
  const source = "// complexity-ignore: no longer needed.\nfunction small() { return 1; }";
  assert.deepEqual(check("probe.ts", source, 3), [
    { line: 1, message: "complexity-ignore allows no function above the limit" },
  ]);
});

test("a marker separated by code does not apply", () => {
  const source = `// complexity-ignore: misplaced.\nconst x = 1;\nfunction big(n) {\n${ifs(3)}\n}`;
  assert.deepEqual(check("probe.ts", source, 3), [
    { line: 1, message: "complexity-ignore allows no function above the limit" },
    { line: 3, message: "big has a complexity of 4 (max 3)" },
  ]);
});

test("a branching class field initializer counts its outermost branch", () => {
  const ternaries = (count) => Array.from({ length: count }, (_, i) => `n === ${i} ? ${i} :`).join(" ");
  const source = (count) => `class Box { n = 0; pick = ${ternaries(count)} -1; logic = a && b; chain = a?.b; }`;
  assert.deepEqual(complexities(source(14)), { n: 1, pick: 15, logic: 2, chain: 2 });
  assert.deepEqual(check("probe.ts", source(14), 15), []);
  assert.deepEqual(check("probe.ts", source(15), 15), [{ line: 1, message: "pick has a complexity of 16 (max 15)" }]);
});
