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
