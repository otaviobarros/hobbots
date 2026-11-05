import assert from "node:assert/strict";
import { test } from "node:test";
import { flakyTestsMarkdown, outcomesOf } from "./flaky-tests.mjs";

const result = (status) => ({ status });
const playwright = {
  suites: [
    {
      title: "chat.e2e.ts",
      file: "chat.e2e.ts",
      specs: [
        {
          title: "[TC-A-001] first",
          file: "chat.e2e.ts",
          line: 3,
          tests: [{ expectedStatus: "passed", results: [result("passed")] }],
        },
      ],
      suites: [
        {
          title: "a group",
          file: "chat.e2e.ts",
          specs: [
            {
              title: "[TC-A-002] retried",
              file: "chat.e2e.ts",
              line: 9,
              tests: [{ expectedStatus: "passed", results: [result("failed"), result("passed")] }],
            },
            {
              title: "[TC-A-003] broken",
              file: "chat.e2e.ts",
              line: 14,
              tests: [{ expectedStatus: "passed", results: [result("timedOut"), result("failed")] }],
            },
            {
              title: "[TC-A-004] skipped",
              file: "chat.e2e.ts",
              line: 20,
              tests: [{ expectedStatus: "skipped", results: [result("skipped")] }],
            },
          ],
        },
      ],
    },
  ],
};

test("a Playwright test that passed on a retry is flaky, one that never passed is failed", () => {
  const outcomes = outcomesOf(playwright);
  assert.deepEqual(
    outcomes.map(({ title, where, runs, passed }) => [title, where, runs, passed]),
    [
      ["[TC-A-001] first", "chat.e2e.ts:3", 1, 1],
      ["a group › [TC-A-002] retried", "chat.e2e.ts:9", 2, 1],
      ["a group › [TC-A-003] broken", "chat.e2e.ts:14", 2, 0],
      ["a group › [TC-A-004] skipped", "chat.e2e.ts:20", 0, 0],
    ],
  );
  const markdown = flakyTestsMarkdown(outcomes);
  assert.match(
    markdown,
    /### Flaky tests[\s\S]*`a group › \[TC-A-002\] retried` \(`chat\.e2e\.ts:9`\), passed 1 of 2 runs/,
  );
  assert.match(markdown, /### Failed tests[\s\S]*`a group › \[TC-A-003\] broken`/);
  assert.doesNotMatch(markdown, /TC-A-001|TC-A-004/);
});

test("a Vitest test that failed on any repeat is failed", () => {
  const vitest = {
    testResults: [
      {
        name: `${process.cwd()}/test/hub.test.ts`,
        assertionResults: [
          { fullName: "hub [TC-OR-403] recovers", status: "failed", location: { line: 12, column: 3 } },
          { fullName: "hub [TC-OR-404] starts", status: "passed" },
          { fullName: "hub [TC-OR-405] later", status: "skipped" },
        ],
      },
    ],
  };
  const markdown = flakyTestsMarkdown(outcomesOf(vitest));
  assert.match(
    markdown,
    /### Failed tests\n\n- `hub \[TC-OR-403\] recovers` \(`test\/hub\.test\.ts:12`\), passed 0 of 1 runs\n/,
  );
  assert.doesNotMatch(markdown, /Flaky|TC-OR-404|TC-OR-405/);
});

test("nothing is printed when every test passed on its first run", () => {
  assert.equal(flakyTestsMarkdown([{ title: "t", where: "f:1", runs: 1, passed: 1 }]), "");
});
