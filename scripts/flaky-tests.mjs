/**
 * Lists the flaky and failed tests in Playwright and Vitest JSON reports as Markdown, for a CI job
 * summary or the nightly flake hunt's issue (STD-TEST-009). A test is flaky when it failed and
 * then passed on a retry or a repeat; it is failed when no run of it passed. The runs of one test
 * in several reports, such as the hunt's three separate runs of a suite, count together. It prints
 * nothing when every test passed on its first run.
 *
 *   node scripts/flaky-tests.mjs [--on <setup>] <report.json>… [--on <setup> <report.json>…]
 *
 * `--on` names the setup the reports after it ran on, such as a database. The same test on two
 * setups is two tests, each listed with its setup: a test that fails every run on PostgreSQL and
 * passes every run on SQLite is failed on PostgreSQL, not flaky.
 *
 * A report that does not exist is skipped, so a job that stopped before writing one still gets a
 * summary of the others.
 */
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";

/**
 * @typedef {{ readonly title: string, readonly where: string, readonly on: string, readonly runs: number, readonly passed: number }} Outcome
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
          on: "",
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
 * Every test in a Vitest JSON report, as one run. The report keeps one result per test, so the
 * flake hunt runs a suite several times, each in a fresh process with its own report, and the
 * runs are counted together (`mergeOutcomes`).
 */
const vitestOutcomes = (report) =>
  report.testResults.flatMap((file) =>
    file.assertionResults
      .filter((test) => test.status === "passed" || test.status === "failed")
      .map((test) => ({
        title: test.fullName,
        where: `${relative(process.cwd(), file.name)}${test.location ? `:${test.location.line}` : ""}`,
        on: "",
        runs: 1,
        passed: test.status === "passed" ? 1 : 0,
      })),
  );

/** The outcomes in a parsed report of either kind. */
export const outcomesOf = (report) =>
  Array.isArray(report.testResults) ? vitestOutcomes(report) : playwrightOutcomes(report);

/**
 * The outcomes with each test's runs in several reports, or Playwright's repeats of it, added up
 * into one, in the order each test first appears. Runs on different setups stay apart.
 */
export const mergeOutcomes = (outcomes) => {
  /** @type {Map<string, Outcome>} */
  const merged = new Map();
  for (const outcome of outcomes) {
    const key = `${outcome.on}\u0000${outcome.where}\u0000${outcome.title}`;
    const seen = merged.get(key);
    merged.set(
      key,
      seen === undefined ? outcome : { ...seen, runs: seen.runs + outcome.runs, passed: seen.passed + outcome.passed },
    );
  }
  return [...merged.values()];
};

const line = (outcome) =>
  `- \`${outcome.title}\` (\`${outcome.where}\`)${outcome.on === "" ? "" : ` on ${outcome.on}`}, passed ${outcome.passed} of ${outcome.runs} runs`;

/** The outcomes in the reports named by the command line's arguments, each after its `--on`. */
export const outcomesOfArguments = (
  args,
  read = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined),
) => {
  /** @type {Outcome[]} */
  const outcomes = [];
  let on = "";
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--on") {
      on = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    const report = read(args[index] ?? "");
    if (report !== undefined) outcomes.push(...outcomesOf(report).map((outcome) => ({ ...outcome, on })));
  }
  return outcomes;
};

/** The Markdown list of flaky and failed tests, or an empty string when there are none. */
export const flakyTestsMarkdown = (outcomes) => {
  const tests = mergeOutcomes(outcomes);
  const flaky = tests.filter((outcome) => outcome.passed > 0 && outcome.passed < outcome.runs);
  const failed = tests.filter((outcome) => outcome.runs > 0 && outcome.passed === 0);
  const sections = [];
  if (flaky.length > 0) {
    sections.push(
      `### Flaky tests\n\nThese failed on one run and passed on another, a retry or a repeat. A test that passes only sometimes is a bug to fix (STD-TEST-009).\n\n${flaky.map(line).join("\n")}\n`,
    );
  }
  if (failed.length > 0) sections.push(`### Failed tests\n\n${failed.map(line).join("\n")}\n`);
  return sections.join("\n");
};

if (import.meta.main) {
  process.stdout.write(flakyTestsMarkdown(outcomesOfArguments(process.argv.slice(2))));
}
