import assert from "node:assert/strict";
import { test } from "node:test";
import { flakyTestsMarkdown, outcomesOf, outcomesOfArguments } from "./flaky-tests.mjs";

const result = (status) => ({ status });
const playwright = {
  suites: [
    {
      title: "chat.e2e.ts",
      file: "chat.e2e.ts",
      specs: [
        {
          title: "first",
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
              title: "retried",
              file: "chat.e2e.ts",
              line: 9,
              tests: [{ expectedStatus: "passed", results: [result("failed"), result("passed")] }],
            },
            {
              title: "broken",
              file: "chat.e2e.ts",
              line: 14,
              tests: [{ expectedStatus: "passed", results: [result("timedOut"), result("failed")] }],
            },
            {
              title: "skipped",
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
      ["first", "chat.e2e.ts:3", 1, 1],
      ["a group › retried", "chat.e2e.ts:9", 2, 1],
      ["a group › broken", "chat.e2e.ts:14", 2, 0],
      ["a group › skipped", "chat.e2e.ts:20", 0, 0],
    ],
  );
  const markdown = flakyTestsMarkdown(outcomes);
  assert.match(markdown, /### Flaky tests[\s\S]*`a group › retried` \(`chat\.e2e\.ts:9`\), passed 1 of 2 runs/);
  assert.match(markdown, /### Failed tests[\s\S]*`a group › broken`/);
  assert.doesNotMatch(markdown, /first|skipped/);
});

test("a Vitest test that failed in its only run is failed", () => {
  const vitest = {
    testResults: [
      {
        name: `${process.cwd()}/test/hub.test.ts`,
        assertionResults: [
          { fullName: "hub recovers", status: "failed", location: { line: 12, column: 3 } },
          { fullName: "hub starts", status: "passed" },
          { fullName: "hub later", status: "skipped" },
        ],
      },
    ],
  };
  const markdown = flakyTestsMarkdown(outcomesOf(vitest));
  assert.match(markdown, /### Failed tests\n\n- `hub recovers` \(`test\/hub\.test\.ts:12`\), passed 0 of 1 runs\n/);
  assert.doesNotMatch(markdown, /Flaky|starts|later/);
});

/** One run's Vitest report of one test with `status`, and of a steady one. */
const exportRun = (status) => ({
  testResults: [
    {
      name: `${process.cwd()}/test/export.test.ts`,
      assertionResults: [
        { fullName: "exports never writes over", status, location: { line: 7, column: 3 } },
        { fullName: "exports steady", status: "passed", location: { line: 30, column: 3 } },
      ],
    },
  ],
});

test("a Vitest test's runs in separate reports count together, so one that failed once is flaky", () => {
  const run = exportRun;
  const outcomes = [run("passed"), run("failed"), run("passed")].flatMap(outcomesOf);
  const markdown = flakyTestsMarkdown(outcomes);
  assert.match(
    markdown,
    /### Flaky tests[\s\S]*`exports never writes over` \(`test\/export\.test\.ts:7`\), passed 2 of 3 runs\n/,
  );
  assert.doesNotMatch(markdown, /Failed tests|steady/);
});

test("the same test on two databases is two tests: one that fails every run on PostgreSQL is failed there, not flaky", () => {
  const run = exportRun;
  const reports = new Map([
    ["sqlite-1.json", run("passed")],
    ["sqlite-2.json", run("passed")],
    ["sqlite-3.json", run("passed")],
    ["postgres-1.json", run("failed")],
    ["postgres-2.json", run("failed")],
    ["postgres-3.json", run("failed")],
  ]);
  const outcomes = outcomesOfArguments(
    [
      "--on",
      "SQLite",
      "sqlite-1.json",
      "sqlite-2.json",
      "sqlite-3.json",
      "--on",
      "PostgreSQL",
      "postgres-1.json",
      "postgres-2.json",
      "postgres-3.json",
      "missing.json",
    ],
    (file) => reports.get(file),
  );
  const markdown = flakyTestsMarkdown(outcomes);
  assert.doesNotMatch(markdown, /Flaky tests|SQLite/);
  assert.match(
    markdown,
    /### Failed tests\n\n- `exports never writes over` \(`test\/export\.test\.ts:7`\) on PostgreSQL, passed 0 of 3 runs\n/,
  );
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
            title: "sometimes",
            file: "quest.e2e.ts",
            line: 5,
            tests: [repeat("passed"), repeat("timedOut"), repeat("passed")],
          },
          {
            title: "never",
            file: "quest.e2e.ts",
            line: 11,
            tests: [repeat("failed"), repeat("failed"), repeat("failed")],
          },
        ],
      },
    ],
  };
  const markdown = flakyTestsMarkdown(outcomesOf(report));
  assert.match(markdown, /`sometimes` \(`quest\.e2e\.ts:5`\), passed 2 of 3 runs/);
  assert.equal(markdown.match(/never/g)?.length, 1);
  assert.match(markdown, /`never` \(`quest\.e2e\.ts:11`\), passed 0 of 3 runs/);
});

test("nothing is printed when every test passed on its first run", () => {
  assert.equal(flakyTestsMarkdown([{ title: "t", where: "f:1", runs: 1, passed: 1 }]), "");
});
