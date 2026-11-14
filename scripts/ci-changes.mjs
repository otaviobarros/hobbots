/**
 * Decides which of CI's slower suites a run needs, from the files a pull request changes (ADR 040).
 * The SQLite checks always run. On a pull request:
 *
 * - The PostgreSQL suites run when the change reaches SQL: the persistence package, or what every
 *   package builds from (dependencies, the toolchain, this workflow).
 * - The browser tests run when the change reaches what the web client shows or decodes: the web
 *   app, the UI and art packages, the API and the domain, or what every package builds from.
 * - Neither runs on a draft. Marking it ready for review runs them.
 *
 * A push to `main` and a merge queue's group run everything, so a change that skipped a suite on
 * its pull request is checked before it lands (merge queue) or right after (push). Prints
 * `database=…` and `browser=…` lines for `$GITHUB_OUTPUT`:
 *
 *   git diff --name-only HEAD^1 HEAD | node scripts/ci-changes.mjs <event> <draft>
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Files every package builds from: a change here reaches every suite. */
const EVERYTHING = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^turbo\.json$/,
  /^tsconfig\.base\.json$/,
  /^\.node-version$/,
  /^\.github\/workflows\/ci\.yml$/,
  /^\.github\/actions\//,
  /^scripts\/ci-changes\.mjs$/,
];

const DATABASE = [/^packages\/persistence\//];

const BROWSER = [/^apps\/web\//, /^packages\/ui\//, /^packages\/art\//, /^packages\/api\//, /^packages\/domain\//];

const touches = (files, patterns) => files.some((file) => [...EVERYTHING, ...patterns].some((p) => p.test(file)));

/**
 * Which slower suites to run for `event` (a GitHub event name), whether its pull request is a
 * draft, and the files it changes.
 */
export const suitesFor = (event, draft, files) => {
  if (event !== "pull_request") return { database: true, browser: true };
  if (draft) return { database: false, browser: false };
  return { database: touches(files, DATABASE), browser: touches(files, BROWSER) };
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [event = "", draft = "false"] = process.argv.slice(2);
  const files = readFileSync(0, "utf8").split("\n").filter(Boolean);
  const suites = suitesFor(event, draft === "true", files);
  console.log(`database=${suites.database}`);
  console.log(`browser=${suites.browser}`);
}
