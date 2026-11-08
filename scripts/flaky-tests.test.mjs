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

test("a Vitest test that failed in its only run is failed", () => {
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

test("a Vitest test's runs in separate reports count together, so one that failed once is flaky", () => {
  const run = (status) => ({
    testResults: [
      {
        name: `${process.cwd()}/test/export.test.ts`,
        assertionResults: [
          { fullName: "exports [TC-OP-042] never writes over", status, location: { line: 7, column: 3 } },
          { fullName: "exports [TC-OP-043] steady", status: "passed", location: { line: 30, column: 3 } },
        ],
      },
    ],
  });
  const outcomes = [run("passed"), run("failed"), run("passed")].flatMap(outcomesOf);
  const markdown = flakyTestsMarkdown(outcomes);
  assert.match(
    markdown,
    /### Flaky tests[\s\S]*`exports \[TC-OP-042\] never writes over` \(`test\/export\.test\.ts:7`\), passed 2 of 3 runs\n/,
  );
  assert.doesNotMatch(markdown, /Failed tests|TC-OP-043/);
});

test("a Playwright test's repeats count together, and a test that never passed is listed once", () => {
  const repeat = (status) => ({ expectedStatus: "passed", results: [result(status)] });
  const report = {
    suites: [
      {
        title: "quest.e2e.ts",
        file: "quest.e2e.ts",
        specs: [
          {
            title: "[TC-B-001] sometimes",
            file: "quest.e2e.ts",
            line: 5,
            tests: [repeat("passed"), repeat("timedOut"), repeat("passed")],
          },
          {
            title: "[TC-B-002] never",
            file: "quest.e2e.ts",
            line: 11,
            tests: [repeat("failed"), repeat("failed"), repeat("failed")],
          },
        ],
      },
    ],
  };
  const markdown = flakyTestsMarkdown(outcomesOf(report));
  assert.match(markdown, /`\[TC-B-001\] sometimes` \(`quest\.e2e\.ts:5`\), passed 2 of 3 runs/);
  assert.equal(markdown.match(/TC-B-002/g)?.length, 1);
  assert.match(markdown, /`\[TC-B-002\] never` \(`quest\.e2e\.ts:11`\), passed 0 of 3 runs/);
});

test("nothing is printed when every test passed on its first run", () => {
  assert.equal(flakyTestsMarkdown([{ title: "t", where: "f:1", runs: 1, passed: 1 }]), "");
});
