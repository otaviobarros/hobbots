/**
 * Lists the flaky and failed tests in Playwright and Vitest JSON reports as Markdown, for a CI job
 * summary or the nightly flake hunt's issue (STD-TEST-009). A test is flaky when it failed and
 * then passed on a retry or a repeat; it is failed when no run of it passed. It prints nothing
 * when every test passed on its first run.
 *
 *   node scripts/flaky-tests.mjs <report.json>…
 *
 * A report that does not exist is skipped, so a job that stopped before writing one still gets a
 * summary of the others.
 */
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";

/**
 * @typedef {{ readonly title: string, readonly where: string, readonly runs: number, readonly passed: number }} Outcome
 */

/** Every test in a Playwright JSON report, with how many of its runs passed. */
const playwrightOutcomes = (report) => {
  /** @type {Outcome[]} */
  const outcomes = [];
  const visit = (suite, path) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        const runs = test.results.filter((result) => result.status !== "skipped");
        outcomes.push({
          title: [...path, spec.title].join(" › "),
          where: `${spec.file}:${spec.line}`,
          runs: runs.length,
          passed: runs.filter((result) => result.status === test.expectedStatus).length,
        });
      }
    }
    // A file's suite is named after the file, which `where` already shows.
    for (const child of suite.suites ?? []) visit(child, child.file === child.title ? path : [...path, child.title]);
  };
  for (const suite of report.suites) visit(suite, []);
  return outcomes;
};

/**
 * Every test in a Vitest JSON report. The report keeps one result per test: with `--repeats`, a
 * test that failed on any of its runs is failed, so it is listed as failed, not flaky.
 */
const vitestOutcomes = (report) =>
  report.testResults.flatMap((file) =>
    file.assertionResults
      .filter((test) => test.status === "passed" || test.status === "failed")
      .map((test) => ({
        title: test.fullName,
        where: `${relative(process.cwd(), file.name)}${test.location ? `:${test.location.line}` : ""}`,
        runs: 1,
        passed: test.status === "passed" ? 1 : 0,
      })),
  );

/** The outcomes in a parsed report of either kind. */
export const outcomesOf = (report) =>
  Array.isArray(report.testResults) ? vitestOutcomes(report) : playwrightOutcomes(report);

const line = (outcome) =>
  `- \`${outcome.title}\` (\`${outcome.where}\`), passed ${outcome.passed} of ${outcome.runs} runs`;

/** The Markdown list of flaky and failed tests, or an empty string when there are none. */
export const flakyTestsMarkdown = (outcomes) => {
  const flaky = outcomes.filter((outcome) => outcome.passed > 0 && outcome.passed < outcome.runs);
  const failed = outcomes.filter((outcome) => outcome.runs > 0 && outcome.passed === 0);
  const sections = [];
  if (flaky.length > 0) {
    sections.push(
      `### Flaky tests\n\nThese failed and then passed on a retry. A retry that passes is a bug to fix (STD-TEST-009).\n\n${flaky.map(line).join("\n")}\n`,
    );
  }
  if (failed.length > 0) sections.push(`### Failed tests\n\n${failed.map(line).join("\n")}\n`);
  return sections.join("\n");
};

if (import.meta.main) {
  const files = process.argv.slice(2).filter((file) => existsSync(file));
  const outcomes = files.flatMap((file) => outcomesOf(JSON.parse(readFileSync(file, "utf8"))));
  process.stdout.write(flakyTestsMarkdown(outcomes));
}
