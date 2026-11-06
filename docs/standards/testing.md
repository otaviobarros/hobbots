# Testing standards

Rules for tests and verification. The [project workflow guide](../agent-engineering.md#checks) lists the test commands and tools.

### STD-TEST-001 Integration and end-to-end tests carry a case ID

Start the title of every integration, end-to-end and regression test with a case ID shaped `[TC-<AREA>-NNN]`. The area is a requirement area from the [MVP requirements](../product/mvp-requirements.md) (`CH`, `OR`, `IN` and so on), or `GEN` when none fits. A comment names the requirements the case covers. Case IDs are never reused or renumbered. A removed case is retired. Pure unit tests need no ID. An existing test gets an ID when it next changes.

- ✅ `it("[TC-CH-001] streams a turn and resumes the session", …) // covers CH-001, CH-004`
- **Why:** a requirement, a bug report and a review can point to the exact case that proves it.
- **Enforced by:** review.
- **Applies to:** integration, end-to-end and regression tests.

### STD-TEST-002 Fakes first, then the real runtime

Verify state transitions, duplicate delivery, restart recovery, permission enforcement and proactive closure with deterministic fake adapters first. Then verify the relevant cases against a real runtime. Report what you could not verify.

- **Why:** fakes make failures repeatable, and the real runtime catches what fakes assume.
- **Enforced by:** review.
- **Applies to:** runtime, orchestration, persistence and permissions work.

### STD-TEST-003 Pure logic has unit tests

Test pure functions with Vitest unit tests, beside the source as `*.test.ts` or under `test/`.

- **Why:** unit tests are the fastest proof that a rule holds.
- **Enforced by:** review.
- **Applies to:** all packages.

### STD-TEST-004 Each user flow has an end-to-end test

Cover each user flow with a Playwright test in `apps/web/e2e`, with a case ID (STD-TEST-001), against the fake runtime. A UI change to a flow adds or updates its end-to-end test in the same pull request. Select elements by role and accessible name.

- **Why:** an end-to-end test proves the flow the user sees, across the server and the client.
- **Enforced by:** the end-to-end CI job and review.
- **Applies to:** `apps/web`.

### STD-TEST-005 Component tests only where end-to-end cannot reach

Write a component render test only for interaction logic that an end-to-end test cannot reach at a reasonable cost. Test everything else through STD-TEST-003 and STD-TEST-004.

- **Why:** component tests cost upkeep and often test the framework instead of behavior.
- **Enforced by:** review.
- **Applies to:** `apps/web`, `packages/ui`.

### STD-TEST-006 Database tests run on SQLite and PostgreSQL

Take the test database from `TestDatabase` in `@hobbots/persistence/testing`, so both CI jobs run the suite on SQLite and on PostgreSQL.

- **Why:** a query that works on one engine can fail on the other (STD-DATA-002).
- **Enforced by:** the CI jobs.
- **Applies to:** suites that use a database.

### STD-TEST-007 Every end-to-end screen passes an accessibility scan

Every end-to-end spec scans each screen it visits with `@axe-core/playwright`, through a shared fixture. The fixture first waits for any fade or color change on the text it checks to finish, since text caught mid-fade reads as low contrast. A serious or critical violation fails the test.

- **Why:** the scan catches missing names, contrast and ARIA mistakes that role selectors alone miss (STD-UI-003).
- **Enforced by:** the shared Playwright fixture and the end-to-end CI job.
- **Applies to:** `apps/web/e2e`.

### STD-TEST-008 Each main flow works by keyboard alone

Onboarding, summoning a hob, chatting and deciding an approval each have an end-to-end spec that runs from start to finish with the keyboard only. A new main flow adds its own.

- **Why:** a flow that needs a mouse at one step is closed to keyboard and screen-reader users (STD-UI-003).
- **Enforced by:** the keyboard-only specs and the end-to-end CI job.
- **Applies to:** `apps/web/e2e`.

### STD-TEST-009 Tests wait on state, and a flaky test is a bug

A test waits for the state it needs, with a time limit, never for a fixed time or a number of tries: a web-first assertion or `expect.poll` in a browser test, a wait on the hub's state in a server test. On CI a failed test runs once more. One that then passes leaves the run green, but it is listed as flaky in the job summary, and it gets an issue within a day or is fixed. The nightly flake hunt runs every suite several times over and keeps one issue listing the tests that failed on any run.

- ✅ `await expect(page.getByRole("status")).toHaveText("Saved")`
- ❌ `await page.waitForTimeout(300)`, or a loop of 1,500 tries 10 ms apart
- **Why:** a fixed wait passes on a quiet laptop and fails on a busy runner, and a flaky test on `main` turns every pull request rebased on it red (#985).
- **Enforced by:** review, the retry and flaky list in each CI job, the burn-in of changed browser tests on pull requests, and the nightly flake hunt.
- **Applies to:** every test.

### STD-TEST-010 The window never scrolls

Each panel scrolls inside the window; the window itself never does. A shared fixture fails every end-to-end test in which, on any screen, the window was scrolled, the window grew taller than the viewport, a box that clips its overflow was scrolled to show what it hides, or an absolutely placed element sits outside the panel it scrolls in. A window shorter than the frame's least height, 610px, may scroll and is not checked.

- ✅ A scroll panel is the box its absolutely placed contents, such as an `sr-only` label, are placed in, so they scroll with it.
- ❌ An `sr-only` label inside a transcript whose panel has no position of its own: the label escapes the panel and stretches the window to the transcript's height (#1026).
- **Why:** a window that scrolls moves the whole frame, sidebar and composer included, and leaves an empty screen under them.
- **Enforced by:** the shared Playwright fixture, `[TC-UX-1026-01]`, which tries to scroll the window on every screen, and the end-to-end CI job.
- **Applies to:** `apps/web`.
